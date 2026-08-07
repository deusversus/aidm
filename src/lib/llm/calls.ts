import { getLangfuse } from "@/lib/observability/langfuse";
import { type ModelCallPhase, recordModelCall } from "@/lib/observability/meter";
import { CommitScene, clampCommitScene } from "@/lib/types/sidecar";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ContentBlockParam,
  JSONOutputFormat,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  MessageStreamParams,
  TextBlockParam,
  Tool,
  ToolChoice,
  ToolUnion,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ZodType } from "zod";
import { z } from "zod";
import { getAnthropic } from "./anthropic";
import {
  FABLE_FALLBACK_MODEL,
  FABLE_MODEL,
  MODEL_CAPS,
  type ModelCaps,
  SERVER_SIDE_FALLBACK_BETA,
  type TierSelection,
} from "./tiers";

/**
 * The traced calls (blueprint substrate discipline): every model call in the
 * codebase flows through streamNarration / callJudgment / callProbe /
 * callSearch. Each call is Langfuse-traced and cost-metered here, at the
 * choke point — if it isn't traced and metered, it doesn't ship.
 *
 * Narration streams FREE PROSE (the one structured-output exemption, §5.7);
 * its typed sidecar arrives as the mandatory commit_scene tool trailer.
 * Judgment and probe use native strict structured output via
 * output_config.format — no prose-JSON parsing anywhere. Search (M3R3 C2)
 * is the second free-prose exemption: server web_search results shape
 * DOWNSTREAM through a separate structured call, never in-request.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Thinking headroom added on top of a call's declared OUTPUT budget (M2R2 §6).
 * Adaptive/always-on thinking bills against max_tokens, so a flat cap sized to
 * the artifact truncates the reasoning first — the clip then reads downstream
 * as a parse failure and retries into the same jar. The pad is that jar's lid,
 * scaled by how hard the model was asked to think.
 *
 * Only a model that does NO server-side reasoning gets 0 (Haiku — neither
 * adaptive thinking nor effort control). Fable's thinking is always-on even
 * though its adaptiveThinking flag is false (the flag means "don't send the
 * param"); effortControl is the honest discriminator, so it is padded like the
 * adaptive models.
 */
function thinkingPad(caps: ModelCaps | undefined, effort?: Effort): number {
  if (!caps || (!caps.adaptiveThinking && !caps.effortControl)) return 0;
  switch (effort) {
    case "low":
      return 8_000;
    case "medium":
      return 12_000;
    case "high":
      // 24k, not 16k (M2R2 audit): genga — the DEFAULT narration tier — ran
      // effort high under the old flat +24k pad; a 16k pad silently shrank
      // its ceiling below the measured deep-scene thinking sizes. Ceilings
      // are free until used.
      return 24_000;
    case "xhigh":
    case "max":
      return 32_000;
    default:
      return 8_000; // an adaptive call with no declared effort still reasons
  }
}

/**
 * The value actually sent to the SDK's max_tokens: the declared output budget
 * plus structural thinking headroom, clamped to the model's real output
 * ceiling. Callers declare only what they intend to PRODUCE (a budgets.ts
 * class); the reasoning room is this mechanism's job, uniformly, at the choke
 * point. Unknown models get no pad and no clamp (the budget passes through).
 */
export function computeEffectiveMaxTokens(
  outputBudget: number,
  model: string,
  effort?: Effort,
): number {
  const caps = MODEL_CAPS[model];
  const padded = outputBudget + thinkingPad(caps, effort);
  return caps ? Math.min(padded, caps.maxOutput) : padded;
}

interface CallContext {
  campaignId?: string;
  turnNumber?: number;
  /**
   * Which lifecycle this spend belongs to (M3 C1). Callers that know their
   * phase state it; turn-scoped work is recognised by its turn number.
   */
  phase?: ModelCallPhase;
}

/**
 * The ledger's phase, resolved at the choke point. A turn number IS the
 * turn-scope evidence, so per-turn callers need no plumbing; a call with
 * neither stays NULL and reports as "(unattributed)" — a named gap rather
 * than spend silently attributed to play (the audit's 47% blind spot).
 */
function resolvePhase(ctx: CallContext): ModelCallPhase | undefined {
  return ctx.phase ?? (ctx.turnNumber !== undefined ? "turn" : undefined);
}

interface StructuredCallOptions<T> extends CallContext {
  /** Trace label, e.g. "outcome_judgment", "intent_probe". */
  name: string;
  schema: ZodType<T>;
  prompt: string;
  system?: string;
  maxTokens?: number;
  effort?: Effort;
  /**
   * Investigation toolkit (§7.1 Director): when supplied together with
   * `executeTool` and `maxToolRounds > 0`, the call runs a budgeted tool loop
   * BEFORE the structured emit — investigation rounds (tools, no output_config)
   * accumulate assistant + tool_result turns, then one final structured round
   * closes them. Absent (the default), the call stays a single structured shot,
   * byte-for-byte the prior behavior.
   */
  tools?: Tool[];
  /** Executes one tool call; returns its result string (errors returned, never thrown). */
  executeTool?: (name: string, input: unknown) => Promise<string>;
  /** Investigation rounds before the final structured emit. 0 (default) = single-shot. */
  maxToolRounds?: number;
  /**
   * Opt-in prefix caching (M2R5 C2), OFF by default: converts `system` into a
   * text block carrying the breakpoint and marks the tail of the opening user
   * turn, so a call whose HEAD repeats within the TTL reads it at 0.1×
   * instead of re-billing it at list price. Only worth it for an in-process
   * loop — the Director's investigation re-sends a 1.2–3.5k head up to six
   * rounds seconds apart ("5m"). Judgment and probe stay bare: their systems
   * run under the per-model cache minimums and their payloads are unique per
   * firing, so a breakpoint would buy a 1.25–2× write nothing ever reads.
   */
  cacheHead?: "5m" | "1h";
}

// Return type inferred deliberately: the two cache counters are always filled
// here (prewarmPrefix reads them as numbers), while `cache_creation` stays
// optional — UsageStats' own contract, minus the optionality this never emits.
function usageStats(usage: Usage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    // The per-TTL split (M2R5 C2): without it the meter prices every write at
    // the 2× 1h rate and overcharges the loops that write at 1.25×.
    ...(usage.cache_creation ? { cache_creation: usage.cache_creation } : {}),
    // The per-search fee (M3R3 C2): a server-tool search bills $10/1k
    // OUTSIDE the token counters — dropping this field ships unmetered spend.
    // The guard is on the OBJECT, not the count: a search-capable round that
    // fired nothing reports 0, and 0 is the state schema.ts documents
    // ("search-capable call, no searches fired"). Guarding on truthiness
    // discarded it as NULL — indistinguishable from every pre-feature row.
    ...(usage.server_tool_use
      ? { web_search_requests: usage.server_tool_use.web_search_requests ?? 0 }
      : {}),
  };
}

/**
 * create() over STREAMING transport, same Message out. The SDK refuses a
 * non-streaming call whose max_tokens implies a >10-minute worst case, and
 * M2R2's padded ceilings crossed that line (live 2026-07-20: Phase A died
 * on production with "Streaming is required for operations that may take
 * longer than 10 minutes"). finalMessage() awaits the full accumulated
 * Message; usage, stop_reason, and content are identical to create().
 */
async function createStreamed(params: MessageCreateParamsNonStreaming): Promise<Message> {
  return getAnthropic().messages.stream(params).finalMessage();
}

/**
 * The FAILURE-CLASS marker (M3R4 R-2). This file already treats the two classes
 * differently — a VALIDATION failure gets one corrective retry, a TRANSPORT
 * failure is rethrown un-retried — but both reached the caller as a bare Error,
 * so a degrade path could only guess which one it was holding. The distinction
 * decides whether retrying HELPS: a caller that degrades on a transport blip
 * spends an irreplaceable one-shot (the pilot plan) on a network hiccup, and a
 * caller that rethrows a schema failure hands the player a permanent 500.
 *
 * A non-enumerable own property, set on the error the SDK already threw: it
 * survives the rethrow, serializes to nothing, and adds no wrapper for a
 * `.message` test upstream to miss. Deliberately NOT a message-regex idiom like
 * evals' TRANSPORT — that one reads strings because it never sees this throw
 * site; here we do, so we can say it rather than infer it.
 */
const TRANSPORT_MARK = "llmTransportFailure";

function markTransport(err: unknown): unknown {
  if (typeof err === "object" && err !== null && Object.isExtensible(err)) {
    Object.defineProperty(err, TRANSPORT_MARK, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return err;
}

/** True when the throw came from the wire, not from what the model emitted. */
export function isTransportFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)[TRANSPORT_MARK] === true
  );
}

/**
 * The output format actually sent: `zodOutputFormat`'s JSON schema WITHOUT the
 * SDK's auto-parse hook (M3R4 R-1).
 *
 * The hook is not a wire field — `parse` is a function, so `JSON.stringify` of
 * the request is byte-for-byte identical with or without it. What it is, is a
 * switch INSIDE the SDK: `maybeParseMessage` keys on `'parse' in format`
 * (sdk/src/lib/parser.ts:53) and, when it is there, zod-validates the
 * accumulated text during STREAM ACCUMULATION (MessageStream.ts:497 →
 * parser.ts:84) and throws `AnthropicError` out of `finalMessage()`.
 *
 * That throw landed in the transport catch below — BEFORE `recordModelCall`,
 * BEFORE the manual parse — which made the corrective retry underneath dead
 * code for every schema violation, and billed every violating call without ever
 * metering it. Measured, N=50 soak (2026-08-05): 13 seed adjudications and one
 * Pacer beat died at parser.ts:84, zero corrective retries fired, zero ledger
 * rows written. Without the hook, `finalMessage()` returns the raw Message and
 * the manual parse below is the only validator — which is the whole point,
 * because it is the one that can retry and the one that meters first.
 *
 * NOTE ON GRAMMAR (measured against SDK 0.90's `transformJSONSchema`): the
 * transform DEMOTES `enum` to `type: "string"` plus a description carrying
 * `{enum: [...]}`. Enum vocabulary is therefore ADVISORY at every level — not
 * merely "nested enums aren't enforced" — so a prompt that spells the values in
 * another case beats the schema every time. See `SEED_VERDICTS` /
 * `PACER_PHASES` normalization in types/direction.ts.
 */
function jsonSchemaFormat<T>(schema: ZodType<T>): JSONOutputFormat {
  const { type, schema: jsonSchema } = zodOutputFormat(schema);
  return { type, schema: jsonSchema };
}

async function callStructured<T>(
  tier: "judgment" | "probe",
  selection: TierSelection,
  opts: StructuredCallOptions<T>,
): Promise<T> {
  const model = selection[tier];
  const caps = MODEL_CAPS[model];
  const outputBudget = opts.maxTokens ?? 1024;
  const effectiveCap = computeEffectiveMaxTokens(outputBudget, model, opts.effort);
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: opts.name,
    tags: [tier],
    metadata: { campaignId: opts.campaignId, turnNumber: opts.turnNumber },
  });

  // The opt-in head breakpoint (M2R5 C2). Absent — the default — both fields
  // stay bare strings and the request is byte-identical to the uncached form.
  const headCache = opts.cacheHead
    ? ({ type: "ephemeral", ttl: opts.cacheHead } as const)
    : undefined;
  const system: MessageCreateParamsNonStreaming["system"] | undefined = opts.system
    ? headCache
      ? [{ type: "text", text: opts.system, cache_control: headCache }]
      : opts.system
    : undefined;

  // The transcript. Single-shot callers leave it at one user turn; an
  // investigation loop (§7.1) grows it in place with tool round-trips before
  // the final structured emit. When no tools run, `messages` is identical to
  // the prior inline literal — the single-shot path stays untouched.
  const messages: MessageParam[] = [
    {
      role: "user",
      content: headCache
        ? [{ type: "text", text: opts.prompt, cache_control: headCache }]
        : opts.prompt,
    },
  ];
  const maxToolRounds = opts.maxToolRounds ?? 0;
  if (opts.tools && opts.tools.length > 0 && opts.executeTool && maxToolRounds > 0) {
    const execute = opts.executeTool;
    // NEVER combine tools with output_config in one request: investigation
    // rounds carry {tools, messages} and NO format; the final round emits.
    for (let round = 0; round < maxToolRounds; round++) {
      const invGeneration = trace?.generation({
        name: `${opts.name}_investigate_${round + 1}`,
        model,
        input: messages,
      });
      const invStarted = Date.now();
      let invMessage: Message;
      try {
        invMessage = await createStreamed({
          model,
          max_tokens: effectiveCap,
          ...(system ? { system } : {}),
          messages,
          tools: opts.tools,
          ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
        });
      } catch (err) {
        const statusMessage = err instanceof Error ? err.message : String(err);
        invGeneration?.end({
          level: "ERROR",
          statusMessage,
          metadata: { latencyMs: Date.now() - invStarted },
        });
        throw markTransport(err);
      }
      const invLatency = Date.now() - invStarted;
      await recordModelCall({
        provider: "anthropic",
        model,
        tier,
        usage: usageStats(invMessage.usage),
        latencyMs: invLatency,
        campaignId: opts.campaignId,
        turnNumber: opts.turnNumber,
        phase: resolvePhase(opts),
        traceId: trace?.id,
      });
      invGeneration?.end({
        usage: { input: invMessage.usage.input_tokens, output: invMessage.usage.output_tokens },
        metadata: { latencyMs: invLatency, stopReason: invMessage.stop_reason },
      });

      // Only a tool_use stop carries calls to answer; a truncated round
      // (max_tokens mid-call) can hold a dangling tool_use that will never get
      // a result — persist only what can be replayed, or the next request 400s
      // on the orphaned block (the C5/SZ lesson: every tool_use gets a result).
      const toolUses =
        invMessage.stop_reason === "tool_use"
          ? invMessage.content.filter((b) => b.type === "tool_use")
          : [];
      const persistable =
        toolUses.length > 0
          ? invMessage.content
          : invMessage.content.filter((b) => b.type !== "tool_use");
      if (persistable.length > 0) messages.push({ role: "assistant", content: persistable });
      if (toolUses.length === 0) break; // the model stopped investigating

      const results: ContentBlockParam[] = [];
      for (const block of toolUses) {
        if (block.type !== "tool_use") continue;
        let output: string;
        try {
          output = await execute(block.name, block.input);
        } catch (err) {
          output = `Tool failed (${err instanceof Error ? err.message : "error"}).`;
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      messages.push({ role: "user", content: results });
    }
    // Close the investigation and demand the structured output. Folded into the
    // trailing user turn when the loop exhausted on a tool_result (no two
    // consecutive user turns); otherwise its own turn after the model's summary.
    const closing = "Investigation complete. Emit the structured output now.";
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push({ type: "text", text: closing });
    } else {
      messages.push({ role: "user", content: closing });
    }
  }

  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: effectiveCap,
    ...(system ? { system } : {}),
    messages,
    output_config: {
      format: jsonSchemaFormat(opts.schema),
      ...(opts.effort && caps?.effortControl ? { effort: opts.effort } : {}),
    },
    ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
  };

  // Manual parse, never the SDK's: any auto-parse (messages.parse(), or a
  // format carrying the zod `parse` hook — see jsonSchemaFormat) throws on a
  // truncated/unparseable response BEFORE usage is readable, and a billed call
  // that never reaches the ledger breaks the choke-point promise.
  //
  // On a VALIDATION failure, one corrective retry (M1 soak): the API's
  // strict output guarantees the JSON shape, not every zod constraint — enum
  // vocabulary in particular is description text, not grammar (jsonSchemaFormat),
  // so an out-of-vocabulary value killed a hard-core combat call and a Director
  // cycle the same way. The model sees its own violation and re-emits once.
  // EVERY attempt is metered — success, retry, and the second failure alike —
  // because recordModelCall fires the moment a Message exists, above any
  // refusal/truncation/parse branch; a second failure then throws (the caller's
  // degrade path owns it).
  let attemptMessages = params.messages;
  let attemptCap = effectiveCap;
  for (let attempt = 0; attempt < 2; attempt++) {
    // ONE GENERATION PER BILLED ATTEMPT (M3R4 R-1), matching the ledger row for
    // row. A single span opened outside this loop ended with only the LAST
    // attempt's usage, so Langfuse reported one call where the meter reported
    // two and the retry's spend was invisible in the trace. Summing the usage
    // into one span would have fixed the total and kept the retry hidden; a
    // span per attempt is also the idiom the rest of this file already uses
    // (the investigation rounds above, callSearch's resumes) and the only one
    // the trace tree renders — trace.generation() hangs every span off the
    // root, so `pnpm langfuse:latest` prints attempts as adjacent rows.
    const generation = trace?.generation({
      name: attempt === 0 ? opts.name : `${opts.name}_retry`,
      model,
      input: attempt === 0 ? opts.prompt : attemptMessages,
    });
    const attemptStarted = Date.now();
    let message: Message;
    try {
      message = await createStreamed({
        ...params,
        messages: attemptMessages,
        max_tokens: attemptCap,
      });
    } catch (err) {
      const statusMessage = err instanceof Error ? err.message : String(err);
      // The last billed-but-unmetered path in the structured call: the
      // transport can fail AFTER the model produced (and billed) output, and
      // usage never reaches the client, so no ledger row can be written. It
      // cannot be metered — but it must never be silent. Same discipline as
      // streamNarration's stream catch.
      console.error(
        "[calls] transport failed — usage unavailable, a billed ledger row may be lost",
        {
          name: opts.name,
          model,
          attempt: attempt + 1,
          error: statusMessage,
        },
      );
      generation?.end({
        level: "ERROR",
        statusMessage,
        metadata: { latencyMs: Date.now() - attemptStarted },
      });
      throw markTransport(err);
    }
    const latencyMs = Date.now() - attemptStarted;

    await recordModelCall({
      provider: "anthropic",
      model,
      tier,
      usage: usageStats(message.usage),
      latencyMs,
      campaignId: opts.campaignId,
      turnNumber: opts.turnNumber,
      phase: resolvePhase(opts),
      traceId: trace?.id,
    });

    if (message.stop_reason === "refusal") {
      generation?.end({ level: "ERROR", statusMessage: "refusal", metadata: { latencyMs } });
      throw new Error(`${opts.name}: model declined (stop_reason=refusal)`);
    }
    // A truncated emit is never silent (M2R2 §6): warn loudly and tag the
    // trace. A clip may parse (a padded output) or fail below; either way the
    // budget, not the schema, is the real story.
    const truncated = message.stop_reason === "max_tokens";
    if (truncated) {
      console.warn("[llm] TRUNCATED at max_tokens", {
        name: opts.name,
        outputBudget,
        effectiveCap: attemptCap,
        model,
      });
    }
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      const parsed = opts.schema.parse(JSON.parse(text));
      generation?.end({
        output: parsed,
        usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
        metadata: {
          latencyMs,
          stopReason: message.stop_reason,
          correctiveRetry: attempt > 0,
          truncated,
        },
      });
      return parsed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt === 0) {
        console.warn(
          `[calls] ${opts.name}: structured output failed validation — one corrective retry`,
        );
        attemptMessages = [
          ...attemptMessages,
          { role: "assistant", content: text || "(empty)" },
          {
            role: "user",
            content: `Your output failed validation:\n${reason}\nEmit the corrected structured output only — same schema, valid values.`,
          },
        ];
        // When the clip caused this failure, the jar was too small: double the
        // OUTPUT budget once (still clamped) so the retry has room to land.
        if (truncated) attemptCap = computeEffectiveMaxTokens(outputBudget * 2, model, opts.effort);
        continue;
      }
      const statusMessage = `structured output failed to parse (stop_reason=${message.stop_reason})`;
      generation?.end({ level: "ERROR", statusMessage, metadata: { latencyMs, truncated } });
      throw new Error(`${opts.name}: ${statusMessage}: ${reason}`);
    }
  }
  throw new Error(`${opts.name}: unreachable (corrective-retry loop exhausted)`);
}

/** Judgment tier: outcome, validation, Sakkan scoring, relevance filter… */
export function callJudgment<T>(
  selection: TierSelection,
  opts: StructuredCallOptions<T>,
): Promise<T> {
  return callStructured("judgment", selection, opts);
}

/** Probe tier: intent/triage, transition checks, routers, extractions. */
export function callProbe<T>(selection: TierSelection, opts: StructuredCallOptions<T>): Promise<T> {
  return callStructured("probe", selection, opts);
}

// ---------------------------------------------------------------------------
// callSearch — the fourth traced call (M3R3 C2)
// ---------------------------------------------------------------------------

export interface SearchCallOptions extends CallContext {
  /** Trace label, e.g. "research_search_power_system". */
  name: string;
  prompt: string;
  system?: string;
  /**
   * Per-CALL search ceiling (the cost knob; $10/1k searches). It takes two
   * enforcements to mean that: `max_uses` caps each API REQUEST server-side,
   * and this function's loop refuses to resume once the accumulated count
   * reaches it. Without the second, every pause_turn resume is a fresh request
   * with a fresh server-side budget and the real ceiling is maxUses ×
   * MAX_ROUNDS.
   */
  maxUses?: number;
  maxTokens?: number;
  effort?: Effort;
}

export interface SearchCallResult {
  /** All prose the model produced across the (possibly paused) turn. */
  text: string;
  /** Claim-level receipts: prose spans tied to their source URLs. */
  citations: { url: string; title: string | null; cited_text: string }[];
  /** Every result the searches surfaced — the consulted-source list. */
  searchedUrls: { url: string; title: string }[];
  /** Billable searches actually fired (metered per round). */
  searchCount: number;
  /**
   * Error codes from searches that FAILED (`web_search_tool_result_error`:
   * too_many_requests, unavailable, max_uses_exceeded…). They arrive on a
   * normal 200, unbilled and result-less, so the model answers anyway — from
   * memory. A result carrying errors and NO searchedUrls is parametric
   * RECALL, not research; callers must gate on it before labelling anything
   * web-sourced.
   */
  errors: string[];
  /**
   * The turn did not finish cleanly — max_tokens clipped it, or the pause
   * budget ran out mid-pause (MAX_ROUNDS or the per-call maxUses ceiling).
   * The prose is partial; the citations that DID land are still real.
   */
  truncated: boolean;
}

/**
 * Free-prose research over the SERVER-SIDE web_search tool (M3R3 C2 — the
 * fallback chain's eyes; v3's complete_with_search carried forward). This is
 * deliberately NOT callStructured with a server tool bolted on:
 *
 * - The house law stands, and it is about output_config.FORMAT: a grammar
 *   never shares a request with tools. Search runs free-text here; callers
 *   shape the prose with a separate callJudgment. (v3 learned the same split:
 *   search + schema in one call produced prose-wrapped JSON and a repair
 *   ladder.) `effort` is not part of that law — streamNarration already sends
 *   tools alongside output_config.effort — so the thinking dial rides along.
 * - The server runs its own sampling loop and can PAUSE it: stop_reason
 *   "pause_turn" means "re-send my content unchanged and let me continue" —
 *   a shape the investigation loop has no branch for.
 * - web_search_20250305 (basic) on purpose: it runs on every judgment-menu
 *   model including Haiku, needs no dynamic-filtering code-execution
 *   plumbing, and research calls fire 2–5 searches, not 20.
 *
 * Every round is metered — including the per-search fee, which bills OUTSIDE
 * the token counters (usageStats threads server_tool_use through).
 */
export async function callSearch(
  selection: TierSelection,
  opts: SearchCallOptions,
): Promise<SearchCallResult> {
  const model = selection.judgment;
  const caps = MODEL_CAPS[model];
  const outputBudget = opts.maxTokens ?? 8192;
  const effectiveCap = computeEffectiveMaxTokens(outputBudget, model, opts.effort);
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: opts.name,
    tags: ["judgment", "web_search"],
    metadata: { campaignId: opts.campaignId },
  });

  const maxUses = opts.maxUses ?? 3;
  const tools: ToolUnion[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: maxUses },
  ];
  const messages: MessageParam[] = [{ role: "user", content: opts.prompt }];

  const collected: Message["content"][] = [];
  let searchCount = 0;
  let truncated = false;
  // True only when the loop's own bound ended a turn the server still wanted
  // to continue — the deliberate breaks below clear it.
  let pendingPause = false;
  // The server loop pauses on long turns; each resume re-sends the paused
  // assistant content UNCHANGED (no closing nudge — the API detects the
  // trailing server_tool_use and continues). Bounded: a turn that pauses
  // more than 4 times is runaway, not research.
  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const generation = trace?.generation({
      name: round === 0 ? opts.name : `${opts.name}_resume_${round}`,
      model,
      input: round === 0 ? opts.prompt : "(pause_turn resume)",
    });
    const started = Date.now();
    let message: Message;
    try {
      message = await createStreamed({
        model,
        max_tokens: effectiveCap,
        ...(opts.system ? { system: opts.system } : {}),
        messages,
        tools,
        ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
        ...(opts.effort && caps?.effortControl ? { output_config: { effort: opts.effort } } : {}),
      });
    } catch (err) {
      const statusMessage = err instanceof Error ? err.message : String(err);
      generation?.end({
        level: "ERROR",
        statusMessage,
        metadata: { latencyMs: Date.now() - started },
      });
      throw err;
    }
    const latencyMs = Date.now() - started;
    const usage = usageStats(message.usage);
    searchCount += usage.web_search_requests ?? 0;
    await recordModelCall({
      provider: "anthropic",
      model,
      tier: "judgment",
      usage,
      latencyMs,
      campaignId: opts.campaignId,
      turnNumber: opts.turnNumber,
      phase: resolvePhase(opts),
      traceId: trace?.id,
    });
    const refused = message.stop_reason === "refusal";
    generation?.end({
      ...(refused ? { level: "ERROR" as const, statusMessage: "refusal" } : {}),
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      metadata: {
        latencyMs,
        stopReason: message.stop_reason,
        webSearchRequests: usage.web_search_requests ?? 0,
      },
    });
    // A declined search is not an empty search: returned as ordinary success
    // it becomes "no live source found this work", and research reports the
    // refusal to the player as a verdict that the work does not exist.
    if (refused) throw new Error(`${opts.name}: model declined (stop_reason=refusal)`);
    if (message.stop_reason === "max_tokens") {
      truncated = true;
      console.warn("[llm] TRUNCATED at max_tokens", {
        name: opts.name,
        outputBudget,
        effectiveCap,
        model,
      });
    }

    collected.push(message.content);
    pendingPause = message.stop_reason === "pause_turn";
    if (!pendingPause) break;
    // The ceiling is per CALL, so it has to be enforced here: each resume is a
    // new API request carrying a fresh server-side max_uses, and a turn that
    // pauses four times would bill 5× the budget the caller asked for.
    if (searchCount >= maxUses) {
      pendingPause = false;
      truncated = true;
      console.warn("[llm] search budget exhausted mid-pause — returning what landed", {
        name: opts.name,
        searchCount,
        maxUses,
        model,
      });
      break;
    }
    messages.push({ role: "assistant", content: message.content as ContentBlockParam[] });
  }
  if (pendingPause) {
    truncated = true;
    console.warn("[llm] search turn cut off mid-pause — MAX_ROUNDS exhausted", {
      name: opts.name,
      rounds: MAX_ROUNDS,
      searchCount,
      model,
    });
  }

  const result: SearchCallResult = {
    text: "",
    citations: [],
    searchedUrls: [],
    searchCount,
    errors: [],
    truncated,
  };
  const texts: string[] = [];
  const seenUrls = new Set<string>();
  for (const blocks of collected) {
    for (const block of blocks) {
      if (block.type === "text") {
        texts.push(block.text);
        for (const c of block.citations ?? []) {
          if (c.type === "web_search_result_location") {
            result.citations.push({ url: c.url, title: c.title, cited_text: c.cited_text });
          }
        }
      } else if (block.type === "web_search_tool_result") {
        // A FAILED search arrives as an error OBJECT on a normal 200 — not a
        // throw, not an empty array (SDK: WebSearchToolResultBlockContent =
        // WebSearchToolResultError | WebSearchResultBlock[]). Discarding it
        // returned a sourceless answer that downstream labels "web research".
        if (Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.type === "web_search_result" && !seenUrls.has(r.url)) {
              seenUrls.add(r.url);
              result.searchedUrls.push({ url: r.url, title: r.title });
            }
          }
        } else {
          result.errors.push(block.content.error_code);
        }
      }
    }
  }
  result.text = texts.join("");
  if (result.errors.length > 0) {
    console.warn("[llm] web search errors — searches failed, the prose may be unsourced", {
      name: opts.name,
      errors: result.errors,
      sources: result.searchedUrls.length,
    });
  }
  trace?.update({
    output: {
      searchCount,
      sources: result.searchedUrls.length,
      chars: result.text.length,
      errors: result.errors,
      truncated,
    },
  });
  return result;
}

/**
 * Cache pre-warm (§5.6): a max_tokens=0 request against the EXACT prefix the
 * real call will send — same tools, same blocks 1–3 — so the player's turn
 * reads warm. Fired by the play view when the input regains focus after
 * >4min idle, and on session open.
 *
 * `tools` is required, not optional (M2R5 C1): tools render AHEAD of `system`
 * in the cache key, so a tool-less pre-warm wrote an entry the KA
 * structurally could not hit — every firing was a pure 2×-rate loss that
 * delivered none of the latency it exists for.
 *
 * max_tokens=0 is the documented pre-warm form: prefill runs, the cache
 * writes, zero output tokens bill (the old max_tokens=1 paid for a token
 * nobody read).
 */
export async function prewarmPrefix(
  selection: TierSelection,
  system: TextBlockParam[],
  tools: ToolUnion[],
  ctx: CallContext = {},
  /** M3R2 C2: Block 3 lives in messages now — the warm must cover it or the
   *  first real call re-writes the whole window. */
  exchangeMessages: MessageParam[] = [],
): Promise<{ cacheCreation: number; cacheRead: number; costUsd: number }> {
  const model = selection.narration;
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: "prewarm",
    tags: ["narration"],
    metadata: { campaignId: ctx.campaignId },
  });
  const started = Date.now();
  let message: Message;
  try {
    message = await getAnthropic().messages.create({
      model,
      max_tokens: 0,
      // No tool_choice: {type:"tool"|"any"} — those are rejected alongside
      // max_tokens=0. Absent is also the RIGHT posture, not merely the legal
      // one: tool_choice stays out of the tools/system key but rides the
      // MESSAGES key (measured 2026-08-05), and Block 3 lives in messages
      // post-C2, so a pre-warm that forced a tool would write a window entry
      // the KA's `auto` round could never read. The exchangeMessages param
      // reproduces the message bytes verbatim; this leaves the posture
      // matching too.
      //
      // PROVEN on the wire, N=50 soak (2026-08-05, model_calls): all three
      // pre-warm writes of the run — 5,647 / 23,445 / 24,505 tokens — were
      // read WHOLE by the next narration call (cache_read equal to the warm
      // write, zero re-creation), the 5,647 by turn 1's KA itself. So the
      // parity this comment argued for is measured, not merely reasoned.
      // One gap remains, and it is spec rather than evidence: the pre-warm
      // sends NO tool_choice while streamNarration always sends an explicit
      // {type:"auto"}. Every measurement says absent and auto key
      // identically; nothing documented guarantees it. If a future pre-warm
      // starts writing entries the KA re-creates, look here first.
      ...(tools.length > 0 ? { tools } : {}),
      system,
      // The documented pre-warm form keeps a placeholder user turn — an empty
      // `messages` array is a 400. The exchange window (Block 3, now real
      // conversation turns) precedes it so the warm covers the moving
      // breakpoint; the placeholder sits AFTER the last breakpoint and never
      // enters the cached prefix.
      messages: [...exchangeMessages, { role: "user", content: "warmup" }],
    });
  } catch (err) {
    const statusMessage = err instanceof Error ? err.message : String(err);
    trace?.update({ output: { error: statusMessage, latencyMs: Date.now() - started } });
    throw err;
  }
  const latencyMs = Date.now() - started;
  const usage = usageStats(message.usage);
  const costUsd = await recordModelCall({
    provider: "anthropic",
    model,
    tier: "narration",
    usage,
    latencyMs,
    campaignId: ctx.campaignId,
    turnNumber: ctx.turnNumber,
    // The function IS the phase: a pre-warm carries the play view's turn
    // number, so the turn-number default would file it as play.
    phase: ctx.phase ?? "prewarm",
    traceId: trace?.id,
  });
  trace?.update({ output: { latencyMs, ...usage } });
  return {
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    costUsd,
  };
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

/** The §5.7 sidecar tool. Schema derives from the CommitScene contract. */
export const COMMIT_SCENE_TOOL: Tool = {
  name: "commit_scene",
  description:
    "MANDATORY trailer: after the narration prose is complete, call this exactly once with the scene's typed sidecar. Never mention this tool in the prose.",
  input_schema: z.toJSONSchema(CommitScene) as Tool.InputSchema,
};

export interface NarrationOptions extends CallContext {
  name?: string;
  selection: TierSelection;
  /** Blocks 1–3, cache_control breakpoints included (assembled by lib/blocks, C5). */
  system: TextBlockParam[];
  messages: MessageParam[];
  maxTokens: number;
  effort?: Effort;
  /**
   * Tool surface for this narration-tier call. Defaults to the §5.7
   * commit_scene trailer (the turn engine's contract); orchestrator-shaped
   * callers (the SZ conductor, Director investigation) supply their own.
   */
  tools?: Tool[];
  /**
   * Tool-use posture. Absent = `auto` — byte-identical to the pre-M3 request,
   * which is the point: every existing caller keeps its exact wire shape.
   * Two callers need more (M3 C1): `{type:"none"}` lets a prose composer send
   * the KA's tool ARRAY (so its prefix matches the KA's cache entry, §5.6)
   * while staying structurally unable to call one; `{type:"tool"}` forces the
   * §5.7 trailer on the continuation round, where no prose is wanted.
   *
   * IT IS NOT FREE (measured on the wire, N=50 soak, 2026-08-05). tool_choice
   * is outside the tools/system cache key — that much was always true — but it
   * is INSIDE the messages key, and since M3R2 C2 the verbatim exchange window
   * lives in `messages`. A caller that changes posture mid-conversation reads
   * the system tier and re-writes the whole window at the 1h 2x rate. Hold the
   * posture constant across a conversation's calls, or price the change (see
   * turn/ka.ts TRAILER_POSTURES for what it cost the trailer round).
   */
  toolChoice?: ToolChoice;
}

export interface NarrationResult {
  message: Message;
  /** The free-prose channel, joined. */
  prose: string;
  /** Parsed commit_scene trailer; null when missing/unparseable (caller runs the §5.7 probe fallback). */
  sidecar: CommitScene | null;
  /** Response served by a different model than requested (Fable→Opus rescue) — Sakkan-relevant. */
  fallbackUsed: boolean;
  /** Whole-chain refusal: empty prose, no sidecar — the caller must not treat this as a scene. */
  refused: boolean;
  costUsd: number;
}

/** Per-attempt usage on a mid-stream fallback rescue; postdates SDK 0.90's Usage type. */
interface UsageIteration {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function extractCommitScene(message: Message): CommitScene | null {
  const block = message.content.find((b) => b.type === "tool_use" && b.name === "commit_scene");
  if (!block || block.type !== "tool_use") return null;
  const parsed = CommitScene.safeParse(block.input);
  if (!parsed.success) {
    console.warn("[narration] commit_scene trailer failed parse", {
      issues: parsed.error.issues.slice(0, 3),
    });
    return null;
  }
  // The counts are enforced here, not by the schema (types/sidecar.ts): the
  // grammar strips length bounds, so an off-count list must clamp, never fail.
  return clampCommitScene(parsed.data, { source: "native" });
}

/**
 * Narration tier: one creative call per scene, streaming. Returns the live
 * SDK stream (pipe `stream.on("text", …)` to the client) plus `done()`,
 * which resolves after the final message with the parsed sidecar, metering
 * and tracing complete.
 */
export function streamNarration(opts: NarrationOptions) {
  const model = opts.selection.narration;
  const caps = MODEL_CAPS[model];
  const effectiveCap = computeEffectiveMaxTokens(opts.maxTokens, model, opts.effort);
  const isFable = model === FABLE_MODEL;
  const name = opts.name ?? "narration";
  const lf = getLangfuse();
  const trace = lf?.trace({
    name,
    tags: ["narration"],
    metadata: { campaignId: opts.campaignId, turnNumber: opts.turnNumber },
  });
  const generation = trace?.generation({ name, model });
  const started = Date.now();

  // tools: [] means a deliberately tool-less narration call — tool_choice with
  // an empty tools array is an API 400, so both fields drop together (C7
  // session agent's catch). The recap/yokoku composers no longer take that
  // road: they send the KA's array under tool_choice `none` (M3 C1) so their
  // prefix can share the KA's cache entry instead of writing a cold one.
  const tools = opts.tools ?? [COMMIT_SCENE_TOOL];
  const params: MessageStreamParams = {
    model,
    max_tokens: effectiveCap,
    system: opts.system,
    messages: opts.messages,
    ...(tools.length > 0
      ? { tools, tool_choice: opts.toolChoice ?? { type: "auto" as const } }
      : {}),
    ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
    ...(opts.effort && caps?.effortControl ? { output_config: { effort: opts.effort } } : {}),
  };

  // `fallbacks` postdates SDK 0.90's types; the API accepts it under the
  // server-side-fallback beta header. Fable narration ALWAYS ships with the
  // Opus 5 fallback configured (§3; Opus 4.8 until 2026-07-25).
  const body = (
    isFable ? { ...params, fallbacks: [{ model: FABLE_FALLBACK_MODEL }] } : params
  ) as MessageStreamParams;
  const requestOptions = isFable
    ? { headers: { "anthropic-beta": SERVER_SIDE_FALLBACK_BETA } }
    : undefined;

  const stream = getAnthropic().messages.stream(body, requestOptions);

  // C9: true TTFT was unmeasured everywhere — latencyMs is call-total and
  // the §5.5 ttft targets were aspiration. Captured here to trace metadata
  // (zero schema change); the C10 soak reads it and sets the targets.
  let ttftMs: number | undefined;
  stream.on("text", () => {
    ttftMs ??= Date.now() - started;
  });

  async function done(): Promise<NarrationResult> {
    let message: Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // Hard stream failure: usage is unavailable client-side. The trace
      // must still close, and the ledger gap must be loud, not silent.
      const statusMessage = err instanceof Error ? err.message : String(err);
      console.error("[narration] stream failed — usage unavailable, ledger row lost", {
        name,
        model,
        error: statusMessage,
      });
      generation?.end({
        level: "ERROR",
        statusMessage,
        metadata: { latencyMs: Date.now() - started },
      });
      throw err;
    }
    const latencyMs = Date.now() - started;
    const fallbackUsed = message.model !== model;
    const iterations = (message.usage as { iterations?: UsageIteration[] }).iterations;
    let costUsd: number;
    if (fallbackUsed && Array.isArray(iterations) && iterations.length > 0) {
      // Mid-stream rescue: the declined attempt's streamed tokens billed at
      // the ORIGINAL model's rates — one ledger row per billed attempt.
      costUsd = 0;
      for (const it of iterations) {
        costUsd += await recordModelCall({
          provider: "anthropic",
          model: it.model ?? message.model,
          tier: "narration",
          usage: {
            input_tokens: it.input_tokens ?? 0,
            output_tokens: it.output_tokens ?? 0,
            cache_read_input_tokens: it.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: it.cache_creation_input_tokens ?? 0,
          },
          latencyMs,
          campaignId: opts.campaignId,
          turnNumber: opts.turnNumber,
          phase: resolvePhase(opts),
          fallbackUsed: true,
          traceId: trace?.id,
        });
      }
    } else {
      // Pre-output rescue (or no rescue): one row at the serving model's rates.
      costUsd = await recordModelCall({
        provider: "anthropic",
        model: message.model,
        tier: "narration",
        usage: usageStats(message.usage),
        latencyMs,
        campaignId: opts.campaignId,
        turnNumber: opts.turnNumber,
        phase: resolvePhase(opts),
        fallbackUsed,
        traceId: trace?.id,
      });
    }
    const refused = message.stop_reason === "refusal";
    if (refused) {
      console.warn("[narration] whole-chain refusal — empty prose, no sidecar", { name, model });
    }
    const truncated = message.stop_reason === "max_tokens";
    if (truncated) {
      console.warn("[llm] TRUNCATED at max_tokens", {
        name,
        outputBudget: opts.maxTokens,
        effectiveCap,
        model,
      });
    }
    const prose = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    generation?.end({
      output: prose,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      metadata: {
        latencyMs,
        ttftMs,
        stopReason: message.stop_reason,
        truncated,
        fallbackUsed,
        servedBy: message.model,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
      },
    });
    return { message, prose, sidecar: extractCommitScene(message), fallbackUsed, refused, costUsd };
  }

  return { stream, done };
}
