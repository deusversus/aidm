import { tiers } from "@/lib/env";
import { type RenderBlocksInput, renderKaBlocks } from "@/lib/ka/blocks";
import { buildMcpServers } from "@/lib/tools";
import type { AidmToolContext } from "@/lib/tools";
import {
  type Options,
  type SDKMessage,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentDeps } from "./types";
import { defaultLogger } from "./types";

/**
 * KeyAnimator — the author-intelligence.
 *
 * KA runs on Claude Agent SDK (not the shared runner). It has:
 *  - 4-block cached `systemPrompt` with SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 *    between the cached session-stable prefix (blocks 1-3) and the
 *    per-turn dynamic suffix (block 4)
 *  - Eight MCP servers for memory/entity access, rebuilt per turn with
 *    the caller's {campaignId, userId, trace} baked in
 *  - Custom subagents ("consultants") KA spawns via the Agent tool —
 *    IntentClassifier, OutcomeJudge, Validator, etc. — though the
 *    router pre-pass typically runs these before KA even starts
 *  - Streaming output: yields text deltas to the caller (SSE handler
 *    forwards them to the browser)
 *
 * Failure: if the Agent SDK subprocess dies or the Anthropic API
 * fails hard, we throw. The SSE handler returns a terminal error
 * event. No fallback "generic narration" — losing KA in mid-scene is
 * fatal to the turn by design; the player gets a retry button.
 */

export interface KeyAnimatorInput extends RenderBlocksInput {
  /**
   * Tool + MCP context. Threaded into every MCP server spawned for this
   * turn so tools authorize against the right campaign + user.
   */
  toolContext: AidmToolContext;
  /**
   * Abort controller for cancelling the turn mid-stream (player clicks
   * stop, page unmounts, etc.).
   */
  abortController?: AbortController;
}

export interface KeyAnimatorYieldText {
  kind: "text";
  delta: string;
}

export interface KeyAnimatorYieldFinal {
  kind: "final";
  narrative: string;
  /** ms from query start to first text_delta. */
  ttftMs: number | null;
  /** ms from query start to result message. */
  totalMs: number;
  /** Total cost in USD reported by Agent SDK. */
  costUsd: number | null;
  sessionId: string | null;
  stopReason: string | null;
}

export type KeyAnimatorEvent = KeyAnimatorYieldText | KeyAnimatorYieldFinal;

export interface KeyAnimatorDeps extends AgentDeps {
  /**
   * Inject a mock `query` function in tests. Defaults to the real
   * `@anthropic-ai/claude-agent-sdk` export.
   */
  queryFn?: typeof query;
}

const EFFORT_DEFAULT: Options["effort"] = "medium";

/**
 * Compose the four blocks into Agent SDK's systemPrompt array with the
 * DYNAMIC_BOUNDARY marker. Everything before the marker is eligible for
 * cross-turn caching; block 4 (post-marker) is per-turn dynamic.
 */
function buildSystemPrompt(
  block1: string,
  block2: string,
  block3: string,
  block4: string,
): string[] {
  return [block1, block2, block3, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, block4];
}

/**
 * Extract text delta from a stream_event message. Returns null if the
 * event isn't a text_delta we care about.
 */
function textDeltaOf(msg: SDKMessage): string | null {
  if (msg.type !== "stream_event") return null;
  const ev = msg.event;
  if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
    return ev.delta.text;
  }
  return null;
}

/**
 * Run KA for one turn. Returns an async generator yielding text deltas
 * as they stream, then a final event with totals. Caller iterates the
 * generator and forwards to SSE / logs / persistence.
 */
export async function* runKeyAnimator(
  input: KeyAnimatorInput,
  deps: KeyAnimatorDeps = {},
): AsyncGenerator<KeyAnimatorEvent, void, void> {
  const logger = deps.logger ?? defaultLogger;
  const queryFn = deps.queryFn ?? query;

  const blocks = renderKaBlocks(input);
  const systemPrompt = buildSystemPrompt(
    blocks.block1,
    blocks.block2,
    blocks.block3,
    blocks.block4,
  );
  // User message is just the player's raw words — all structured context
  // (intent, outcome, scene, overrides, sakuga, style drift, vocab
  // freshness) is already rendered into Block 4 of the system prompt.
  const userMessage = input.block4.player_message;

  const mcpServers = buildMcpServers(input.toolContext);

  const abortController = input.abortController ?? new AbortController();

  // Agent SDK options. Everything here is load-bearing:
  //   - tools: []            → don't expose Claude Code's filesystem preset
  //   - mcpServers: ours     → the seven cognitive layers + entities
  //   - permissionMode: bypass + allow flag → no UI permission prompts
  //     (we're a server-side narrator; the player never sees them)
  //   - settingSources: []   → don't auto-load user/project settings from disk
  //   - persistSession: false → no JSONL written to ~/.claude/projects
  //   - includePartialMessages: true → stream text deltas
  //   - thinking.adaptive + effort: medium → per M1 plan
  //   - systemPrompt with DYNAMIC_BOUNDARY → cache blocks 1-3, keep 4 dynamic
  const options: Options = {
    model: tiers.creative.model,
    systemPrompt,
    tools: [],
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    thinking: { type: "adaptive" },
    effort: EFFORT_DEFAULT,
    abortController,
    env: process.env,
  };

  const start = Date.now();
  let ttftMs: number | null = null;
  let narrative = "";
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let costUsd: number | null = null;

  const span = deps.trace?.span({
    name: "agent:key-animator",
    input: {
      player_message: userMessage,
      intent: input.block4.intent,
    },
    metadata: { model: tiers.creative.model, tier: "creative" },
  });

  try {
    for await (const msg of queryFn({ prompt: userMessage, options })) {
      // Track session id as soon as we see one — helps trace correlation.
      if (msg.type === "system" && "session_id" in msg) {
        sessionId = (msg as { session_id?: string }).session_id ?? sessionId;
      }
      const delta = textDeltaOf(msg);
      if (delta) {
        if (ttftMs === null) ttftMs = Date.now() - start;
        narrative += delta;
        yield { kind: "text", delta };
        continue;
      }
      if (msg.type === "result") {
        stopReason = msg.stop_reason;
        costUsd = msg.subtype === "success" ? msg.total_cost_usd : null;
        sessionId = msg.session_id ?? sessionId;
        if (msg.subtype !== "success") {
          const err = `KA result error: ${msg.subtype}`;
          logger("error", err, { sessionId, stopReason });
          throw new Error(err);
        }
      }
    }

    const totalMs = Date.now() - start;
    span?.end({
      output: {
        narrative_length: narrative.length,
        ttft_ms: ttftMs,
        total_ms: totalMs,
        cost_usd: costUsd,
        stop_reason: stopReason,
      },
    });

    yield {
      kind: "final",
      narrative,
      ttftMs,
      totalMs,
      costUsd,
      sessionId,
      stopReason,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "KeyAnimator stream failed", {
      error: errMsg,
      ttft_ms: ttftMs,
      partial_narrative_length: narrative.length,
    });
    span?.end({
      metadata: {
        error: errMsg,
        ttft_ms: ttftMs,
        partial_narrative_length: narrative.length,
      },
    });
    throw err;
  }
}
