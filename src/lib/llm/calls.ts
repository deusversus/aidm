import { getLangfuse } from "@/lib/observability/langfuse";
import { recordModelCall } from "@/lib/observability/meter";
import { CommitScene } from "@/lib/types/sidecar";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
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
}

function usageStats(usage: Usage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

async function callStructured<T>(
  tier: "judgment" | "probe",
  selection: TierSelection,
  opts: StructuredCallOptions<T>,
): Promise<T> {
  const model = selection[tier];
  const caps = MODEL_CAPS[model] ?? { adaptiveThinking: false, effortControl: false };
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: opts.name,
    tags: [tier],
    metadata: { campaignId: opts.campaignId, turnNumber: opts.turnNumber },
  });
  const generation = trace?.generation({ name: opts.name, model, input: opts.prompt });
  const started = Date.now();

  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.prompt }],
    output_config: {
      format: zodOutputFormat(opts.schema),
      ...(opts.effort && caps.effortControl ? { effort: opts.effort } : {}),
    },
    ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
  };

  // create() + manual parse, NOT messages.parse(): parse() throws on a
  // truncated/unparseable response BEFORE usage is readable, and a billed
  // call that never reaches the ledger breaks the choke-point promise.
  let message: Message;
  try {
    message = await getAnthropic().messages.create(params);
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
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed: T;
  try {
    parsed = opts.schema.parse(JSON.parse(text));
  } catch (err) {
    const statusMessage = `structured output failed to parse (stop_reason=${message.stop_reason})`;
    generation?.end({ level: "ERROR", statusMessage, metadata: { latencyMs } });
    throw new Error(
      `${opts.name}: ${statusMessage}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  generation?.end({
    output: parsed,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
    metadata: { latencyMs, stopReason: message.stop_reason },
  });
  return parsed;
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
  const caps = MODEL_CAPS[model] ?? { adaptiveThinking: false, effortControl: false };
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

  const params: MessageStreamParams = {
    model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: [COMMIT_SCENE_TOOL],
    tool_choice: { type: "auto" },
    ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" } } : {}),
    ...(opts.effort && caps.effortControl ? { output_config: { effort: opts.effort } } : {}),
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
    const prose = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    generation?.end({
      output: prose,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
      metadata: {
        latencyMs,
        stopReason: message.stop_reason,
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
