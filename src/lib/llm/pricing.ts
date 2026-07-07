/**
 * Pricing table — per-1M-token USD rates for every model the engine can
 * invoke. The cost meter (observability/meter.ts) computes each row's
 * costUsd from this; §10.8's budget assertions read the same math.
 *
 * The menus are closed (§3), so an unknown model here is a defect, not a
 * fallback case — pricingFor THROWS rather than guessing a rate that would
 * silently corrupt the ledger.
 *
 * Rates as of 2026-07 (user-confirmed model set). Cache math per Anthropic:
 * read = 0.1× input, 5-minute-TTL write = 1.25× input.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read input tokens. */
  cacheReadPer1M: number;
  /** USD per 1M cache-creation input tokens (5m TTL). */
  cacheCreationPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": {
    inputPer1M: 10,
    outputPer1M: 50,
    cacheReadPer1M: 1,
    cacheCreationPer1M: 12.5,
  },
  "claude-opus-4-8": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheCreationPer1M: 6.25,
  },
  // List price; an intro rate ($2/$10) runs through 2026-08-31 — we meter
  // at list, a deliberate over-estimate that self-corrects in September.
  "claude-sonnet-5": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheCreationPer1M: 3.75,
  },
  "claude-haiku-4-5": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheCreationPer1M: 1.25,
  },
  // Voyage bills input tokens only (embeddings have no output tokens).
  "voyage-3.5": {
    inputPer1M: 0.06,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheCreationPer1M: 0,
  },
};

export function pricingFor(model: string): ModelPricing {
  const p = PRICING[model];
  if (!p) {
    throw new Error(`no pricing for model "${model}" — menus are closed (§3); add the rate first`);
  }
  return p;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Compute total USD cost for a given model + usage breakdown. */
export function estimateCostUsd(model: string, usage: UsageStats): number {
  const p = pricingFor(model);
  const inputCost = (usage.input_tokens / 1_000_000) * p.inputPer1M;
  const outputCost = (usage.output_tokens / 1_000_000) * p.outputPer1M;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheReadPer1M;
  const cacheCreationCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheCreationPer1M;
  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}
