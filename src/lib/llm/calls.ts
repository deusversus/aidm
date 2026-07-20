import { getLangfuse } from "@/lib/observability/langfuse";
import { recordModelCall } from "@/lib/observability/meter";
import { CommitScene } from "@/lib/types/sidecar";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  MessageStreamParams,
  TextBlockParam,
  Tool,
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
 * The traced trio (blueprint substrate discipline): every model call in the
 * codebase flows through streamNarration / callJudgment / callProbe. Each
 * call is Langfuse-traced and cost-metered here, at the choke point — if it
 * isn't traced and metered, it doesn't ship.
 *
 * Narration streams FREE PROSE (the one structured-output exemption, §5.7);
 * its typed sidecar arrives as the mandatory commit_scene tool trailer.
 * Judgment and probe use native strict structured output via
 * output_config.format — no prose-JSON parsing anywhere.
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
}

function usageStats(usage: Usage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
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

  // The transcript. Single-shot callers leave it at one user turn; an
  // investigation loop (§7.1) grows it in place with tool round-trips before
  // the final structured emit. When no tools run, `messages` is identical to
  // the prior inline literal — the single-shot path stays untouched.
  const messages: MessageParam[] = [{ role: "user", content: opts.prompt }];
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
          ...(opts.system ? { system: opts.system } : {}),
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
        throw err;
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

  const generation = trace?.generation({ name: opts.name, model, input: opts.prompt });
  const started = Date.now();

  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: effectiveCap,
    ...(opts.system ? { system: opts.system } : {}),
    messages,
    output_config: {
      format: zodOutputFormat(opts.schema),
      ...(opts.effort && caps?.effortControl ? { effort: opts.effort } : {}),
    },
    ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
  };

  // create() + manual parse, NOT messages.parse(): parse() throws on a
  // truncated/unparseable response BEFORE usage is readable, and a billed
  // call that never reaches the ledger breaks the choke-point promise.
  //
  // On a VALIDATION failure, one corrective retry (M1 soak): the API's
  // strict output guarantees the grammar, not every zod constraint — a
  // nested enum leaked an out-of-vocabulary value and killed a hard-core
  // combat call, and a Director cycle died the same way. The model sees its
  // own violation and re-emits once. Every attempt is metered; a second
  // failure throws (the caller's degrade path owns it).
  let attemptMessages = params.messages;
  let attemptCap = effectiveCap;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      generation?.end({
        level: "ERROR",
        statusMessage,
        metadata: { latencyMs: Date.now() - started },
      });
      throw err;
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

/**
 * Cache pre-warm (§5.6): a max_tokens=1 request against the exact blocks
 * 1–3 prefix so the player's real call reads warm. Fired by the play view
 * when the input regains focus after >4min idle (client hook lands M1).
 */
export async function prewarmPrefix(
  selection: TierSelection,
  system: TextBlockParam[],
  ctx: CallContext = {},
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
      max_tokens: 1,
      system,
      messages: [{ role: "user", content: "." }],
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
  return parsed.data;
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

  // tools: [] means a deliberately tool-less narration call (recap/yokoku,
  // §9.3/§9.4) — tool_choice with an empty tools array is an API 400, so
  // both fields drop together (C7 session agent's catch).
  const tools = opts.tools ?? [COMMIT_SCENE_TOOL];
  const params: MessageStreamParams = {
    model,
    max_tokens: effectiveCap,
    system: opts.system,
    messages: opts.messages,
    ...(tools.length > 0 ? { tools, tool_choice: { type: "auto" as const } } : {}),
    ...(caps?.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
    ...(opts.effort && caps?.effortControl ? { output_config: { effort: opts.effort } } : {}),
  };

  // `fallbacks` postdates SDK 0.90's types; the API accepts it under the
  // server-side-fallback beta header. Fable narration ALWAYS ships with the
  // Opus 4.8 fallback configured (§3).
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
