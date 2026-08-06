import { getDb } from "@/lib/db";
import { modelCalls } from "@/lib/db/schema";
import { type UsageStats, estimateCostUsd } from "@/lib/llm/pricing";

/**
 * The cost meter (blueprint §3): every model call — Anthropic, Voyage,
 * later media — lands one row in model_calls with cache accounting. The
 * four traced calls (llm/calls.ts) and the Voyage client are the only
 * callers; nothing else in the codebase talks to a model API.
 *
 * A meter write failure is logged LOUDLY but never fails the model call
 * itself — losing one ledger row beats losing a player's turn. If these
 * errors ever recur in traces, that's a defect to fix, not noise.
 */

/**
 * Which lifecycle a call was spent on (M3 C1). The 2026-08-01 audit measured
 * 47% of real spend invisible to per-turn telemetry — session opens, recaps,
 * pre-warms and Director cycles all landed as turn-less rows the cost model
 * silently read as free play. The tier says WHAT ran; the phase says WHY.
 * Rows written before this column exists stay NULL and report as
 * "(unattributed)" — an honest gap, never a zero.
 */
export type ModelCallPhase =
  | "turn"
  | "session_open"
  | "session_close"
  | "prewarm"
  | "director_cycle"
  | "sz"
  | "booth"
  | "research"
  | "suggestion"
  | "tts"
  /**
   * Spend the HARNESS made, not the engine: the soak's synthetic player, the
   * exit gauge's classifier. Named because the alternatives both lie — the
   * N=50 soak left 48 turn-less probe rows in "(unattributed)" (we knew
   * exactly why they were spent), and a turn number would have filed a
   * simulated player's typing as the cost of play.
   */
  | "harness";

export interface ModelCallRecord {
  provider: "anthropic" | "voyage";
  model: string;
  tier: "narration" | "judgment" | "probe" | "embedding";
  phase?: ModelCallPhase;
  /**
   * UsageStats, not a local shape: the optional per-TTL `cache_creation`
   * split has to survive the hop to estimateCostUsd or a 5m write meters at
   * the 2× rate. The ROW stays flat (two token columns, no split) — the
   * split changes the price, not the schema.
   */
  usage: UsageStats;
  latencyMs: number;
  campaignId?: string;
  turnNumber?: number;
  fallbackUsed?: boolean;
  traceId?: string;
}

export async function recordModelCall(record: ModelCallRecord): Promise<number> {
  // Pricing failure (e.g. the API returning a dated model id not in the
  // table) must not kill a call that already succeeded — write the row
  // unpriced and shout.
  let costUsd = 0;
  try {
    costUsd = estimateCostUsd(record.model, record.usage);
  } catch (err) {
    console.error("[meter] UNPRICED model — row written at $0, fix the pricing table", {
      model: record.model,
      tier: record.tier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await getDb()
      .insert(modelCalls)
      .values({
        campaignId: record.campaignId,
        turnNumber: record.turnNumber,
        provider: record.provider,
        model: record.model,
        tier: record.tier,
        phase: record.phase,
        inputTokens: record.usage.input_tokens,
        outputTokens: record.usage.output_tokens,
        cacheReadInputTokens: record.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: record.usage.cache_creation_input_tokens ?? 0,
        webSearchRequests: record.usage.web_search_requests,
        costUsd: costUsd.toFixed(6),
        latencyMs: record.latencyMs,
        fallbackUsed: record.fallbackUsed ?? false,
        traceId: record.traceId,
      });
  } catch (err) {
    console.error("[meter] WRITE FAILED — cost row lost", {
      model: record.model,
      tier: record.tier,
      costUsd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return costUsd;
}
