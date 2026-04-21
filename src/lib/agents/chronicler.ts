import { getQueryFn } from "@/lib/llm/mock/runtime";
import { getPrompt } from "@/lib/prompts";
import type { CampaignProviderConfig } from "@/lib/providers";
import { buildMcpServers } from "@/lib/tools";
import type { AidmToolContext } from "@/lib/tools";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import type { AgentDefinition, Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDeps } from "./types";
import { defaultLogger } from "./types";

/**
 * Chronicler — post-turn archivist.
 *
 * Runs in the background after KA finishes a turn (wired via Next's
 * `after()` in Commit 7.4). Chronicler reads the completed turn's
 * player message + narrative + intent + outcome, and writes durable
 * state via the 15 Chronicler write tools: NPC catalog, locations,
 * factions, semantic memory, episodic summary, relationship events,
 * foreshadowing candidates, arc plan history, voice patterns,
 * director notes, spotlight debt. Every write goes through the
 * existing MCP surface so authz + Zod + span wrapping fire uniformly.
 *
 * Subagents:
 *   - `relationship-analyzer` (thinking tier) — spawned for subtle
 *     emotional movement that's hard to classify confidently. Chronicler
 *     reads its output and persists each milestone via
 *     `record_relationship_event`.
 *
 * Architecture (three-phase turn):
 *   Scenewright (before) → KeyAnimator (turn) → Chronicler (after)
 *
 * Non-blocking: Chronicler runs after the SSE `done` event fires, so
 * the player never waits on it. Failures are logged but don't
 * retroactively fail the turn (Commit 7.4 handles that semantics).
 *
 * Provider-gated: runs only on `provider === "anthropic"` at M1.
 * Google-KA / OpenAI-KA land M3.5 / M5.5 with their own native
 * Chronicler implementations; throwing here surfaces misconfigured
 * campaigns loudly rather than silently wrong-provider dispatching.
 */

export type ArcTrigger = "hybrid" | "session_boundary" | null;

export interface ChroniclerInput {
  /** Turn number Chronicler is cataloguing. */
  turnNumber: number;
  /** The player's raw message for this turn. */
  playerMessage: string;
  /** KA's streamed narrative text. */
  narrative: string;
  /** IntentClassifier's output for the player's message. */
  intent: IntentOutput;
  /** OutcomeJudge's verdict. Null for router short-circuits (META, OVERRIDE, WB). */
  outcome: OutcomeOutput | null;
  /**
   * Trigger for arc-level writes (update_arc_plan, update_voice_patterns,
   * write_director_note). Null = regular turn; Chronicler skips arc-level
   * tools. "hybrid" = mid-session at epicness ≥ 0.6 every 3+ turns.
   * "session_boundary" = last turn of a session. Caller (turn workflow)
   * decides; Chronicler respects.
   */
  arcTrigger: ArcTrigger;
  /**
   * Per-campaign provider + tier_models. Chronicler runs on fast tier;
   * the relationship-analyzer consultant runs on thinking tier.
   */
  modelContext: CampaignProviderConfig;
  /**
   * Tool + MCP context. Threaded into the MCP servers built for this
   * run so every write authorizes against the right campaign + user.
   */
  toolContext: AidmToolContext;
  /** Abort controller for cancelling the pass (e.g. server shutdown). */
  abortController?: AbortController;
}

export interface ChroniclerResult {
  sessionId: string | null;
  stopReason: string | null;
  costUsd: number | null;
  totalMs: number;
  /**
   * Count of `tool_use` content blocks observed in the session. Proxy
   * for "work done" — a Chronicler run that made 0 tool calls on a
   * non-trivial turn is suspicious (failed to even write the episodic
   * summary). Caller can alarm on this.
   */
  toolCallCount: number;
}

export interface ChroniclerDeps extends AgentDeps {
  /** Inject a mock `query` function in tests. */
  queryFn?: typeof query;
}

function buildChroniclerConsultants(
  modelContext: CampaignProviderConfig,
): Record<string, AgentDefinition> {
  const thinking = modelContext.tier_models.thinking;
  return {
    "relationship-analyzer": {
      description:
        "Detect relationship milestones (first_trust, first_vulnerability, first_sacrifice, first_betrayal, reconciliation, bond_broken, etc.) from the turn's narrative when the emotional movement is subtle enough that classification isn't obvious. Pass the narrative, present NPCs, intent, and outcome. Returns structured { affinityDeltas, milestones, rationale } — persist each milestone via record_relationship_event.",
      prompt: getPrompt("agents/relationship-analyzer").content,
      model: thinking,
      tools: [],
    },
  };
}

function buildUserContent(input: ChroniclerInput): string {
  const outcomeLine = input.outcome
    ? `outcome: ${input.outcome.narrative_weight} ${input.outcome.success_level}${input.outcome.consequence ? ` — ${input.outcome.consequence}` : ""}`
    : "outcome: (none — no pre-judgment; trivial action or short-circuit path)";
  const arcLine = input.arcTrigger
    ? `arc_trigger: ${input.arcTrigger} — arc-level tools (update_arc_plan, update_voice_patterns, write_director_note) ARE enabled this pass`
    : "arc_trigger: null — arc-level tools are DISABLED this pass; skip steps 7–9";
  return [
    `turn_number: ${input.turnNumber}`,
    `intent: ${input.intent.intent} (epicness ${input.intent.epicness.toFixed(2)}, confidence ${input.intent.confidence.toFixed(2)})`,
    outcomeLine,
    arcLine,
    "",
    "player_message:",
    input.playerMessage,
    "",
    "narrative:",
    input.narrative,
    "",
    "Catalog what happened now. Return a 1–2 sentence trace summary when you're done.",
  ].join("\n");
}

/**
 * Count tool_use content blocks on an assistant message. Chronicler's
 * value is measured in tool calls (DB writes), not in the text it
 * echoes back, so we track this as a proxy for work done.
 */
function countToolUseBlocks(msg: SDKMessage): number {
  if (msg.type !== "assistant") return 0;
  const message = (msg as { message?: { content?: Array<{ type?: string }> } }).message;
  const content = message?.content ?? [];
  return content.filter((c) => c?.type === "tool_use").length;
}

export async function runChronicler(
  input: ChroniclerInput,
  deps: ChroniclerDeps = {},
): Promise<ChroniclerResult> {
  const logger = deps.logger ?? defaultLogger;
  // Env-gated mock swap (Phase D of mockllm plan). Explicit deps.queryFn wins.
  const queryFn = deps.queryFn ?? getQueryFn();

  if (input.modelContext.provider !== "anthropic") {
    throw new Error(
      `Chronicler on Claude Agent SDK only supports provider="anthropic" (got "${input.modelContext.provider}"). Google-Chronicler lands M3.5; OpenAI / OpenRouter at M5.5.`,
    );
  }
  const fastModel = input.modelContext.tier_models.fast;

  // Record prompt fingerprints for the audit trail (same pattern as KA +
  // structured agents). Non-fatal if the prompt registry lookup fails —
  // a chronicling run still completes without the fingerprint recorded.
  if (deps.recordPrompt) {
    try {
      deps.recordPrompt("chronicler", getPrompt("agents/chronicler").fingerprint);
    } catch {
      /* non-fatal */
    }
    try {
      deps.recordPrompt(
        "chronicler:consultant:relationship-analyzer",
        getPrompt("agents/relationship-analyzer").fingerprint,
      );
    } catch {
      /* non-fatal */
    }
  }

  const systemPrompt = getPrompt("agents/chronicler").content;
  const userMessage = buildUserContent(input);
  const mcpServers = buildMcpServers(input.toolContext);
  const abortController = input.abortController ?? new AbortController();

  // Agent SDK options. Chronicler differs from KA:
  //   - model: fast tier (Haiku by default) — Chronicler is cataloguing,
  //     not authoring; fast tier is appropriate.
  //   - tools: []                → don't expose Claude Code's filesystem preset
  //   - mcpServers: ours         → Chronicler calls register_npc /
  //     write_semantic_memory / etc. through the eight MCP servers; the
  //     write tools registered in Commit 7.2 live there.
  //   - agents: relationship-analyzer (thinking tier) as a consultant
  //   - permissionMode: bypass   → Chronicler runs server-side
  //   - settingSources: []       → no user/project config from disk
  //   - persistSession: false    → no JSONL side-effects
  //   - includePartialMessages: false → Chronicler doesn't stream to the
  //     user; we only care about the final result + tool call counts
  //   - no thinking.adaptive     → fast tier doesn't need it; keeps
  //     per-turn latency budget sane
  const options: Options = {
    model: fastModel,
    systemPrompt,
    tools: [],
    mcpServers,
    agents: buildChroniclerConsultants(input.modelContext),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: false,
    abortController,
    env: process.env,
  };

  const start = Date.now();
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let costUsd: number | null = null;
  let toolCallCount = 0;

  const span = deps.trace?.span({
    name: "agent:chronicler",
    input: {
      turn_number: input.turnNumber,
      intent: input.intent.intent,
      arc_trigger: input.arcTrigger ?? "none",
    },
    metadata: {
      model: fastModel,
      provider: input.modelContext.provider,
      tier: "fast",
    },
  });

  try {
    for await (const msg of queryFn({ prompt: userMessage, options })) {
      if (msg.type === "system" && "session_id" in msg) {
        sessionId = (msg as { session_id?: string }).session_id ?? sessionId;
      }
      toolCallCount += countToolUseBlocks(msg);
      if (msg.type === "result") {
        stopReason = msg.stop_reason;
        costUsd = msg.subtype === "success" ? msg.total_cost_usd : null;
        sessionId = msg.session_id ?? sessionId;
        if (msg.subtype !== "success") {
          const err = `Chronicler result error: ${msg.subtype}`;
          logger("error", err, { sessionId, stopReason });
          throw new Error(err);
        }
      }
    }

    const totalMs = Date.now() - start;
    span?.end({
      output: {
        tool_call_count: toolCallCount,
        total_ms: totalMs,
        cost_usd: costUsd,
        stop_reason: stopReason,
      },
    });

    return { sessionId, stopReason, costUsd, totalMs, toolCallCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "Chronicler run failed", {
      error: errMsg,
      turn_number: input.turnNumber,
      tool_calls_before_error: toolCallCount,
    });
    span?.end({
      metadata: {
        error: errMsg,
        tool_calls_before_error: toolCallCount,
      },
    });
    throw err;
  }
}
