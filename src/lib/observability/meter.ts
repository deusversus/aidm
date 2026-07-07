import { getDb } from "@/lib/db";
import { modelCalls } from "@/lib/db/schema";
import { estimateCostUsd } from "@/lib/llm/pricing";

/**
 * The cost meter (blueprint §3): every model call — Anthropic, Voyage,
 * later media — lands one row in model_calls with cache accounting. The
 * traced call trio (llm/calls.ts) and the Voyage client are the only
 * callers; nothing else in the codebase talks to a model API.
 *
 * A meter write failure is logged LOUDLY but never fails the model call
 * itself — losing one ledger row beats losing a player's turn. If these
 * errors ever recur in traces, that's a defect to fix, not noise.
 */

export interface ModelCallRecord {
  provider: "anthropic" | "voyage";
  model: string;
  tier: "narration" | "judgment" | "probe" | "embedding";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
        inputTokens: record.usage.input_tokens,
        outputTokens: record.usage.output_tokens,
        cacheReadInputTokens: record.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: record.usage.cache_creation_input_tokens ?? 0,
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
