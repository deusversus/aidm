/**
 * Hardcoded pricing table for MockLLM cost emulation.
 *
 * The real Anthropic API reports `total_cost_usd` on its result events;
 * to make cost-aware tests realistic under the mock, we synthesize the
 * same figure from a known pricing table keyed by model.
 *
 * Values reflect published per-1M-token rates as of 2026-04. Update
 * here if pricing shifts — the mock doesn't care about accuracy beyond
 * "plausible enough for regression gating," and hardcoded is simpler
 * than env-configurable until billing tests regress under drift.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read input tokens (90% discount on Anthropic). */
  cacheReadPer1M: number;
  /** USD per 1M cache-creation input tokens (25% premium on Anthropic). */
  cacheCreationPer1M: number;
}

const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.7 (M0 default creative tier)
  "claude-opus-4-7": {
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheCreationPer1M: 18.75,
  },
  // Claude Opus 4.5 snapshot (alternate thinking pin)
  "claude-opus-4-5-20251101": {
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheCreationPer1M: 18.75,
  },
  // Claude Sonnet 4.6 (cost-down creative alternative)
  "claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheCreationPer1M: 3.75,
  },
  // Claude Haiku 4.5 (probe + fast tier default)
  "claude-haiku-4-5-20251001": {
    inputPer1M: 0.25,
    outputPer1M: 1.25,
    cacheReadPer1M: 0.025,
    cacheCreationPer1M: 0.3125,
  },
};

const GOOGLE_PRICING: Record<string, ModelPricing> = {
  // Gemini 3.1 Pro (M3.5+ thinking alternative)
  "gemini-3.1-pro-preview": {
    inputPer1M: 1.25,
    outputPer1M: 5,
    cacheReadPer1M: 0.3125,
    cacheCreationPer1M: 0,
  },
  // Gemini 3.1 Flash-Lite (fast tier candidate)
  "gemini-3.1-flash-lite-preview": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    cacheReadPer1M: 0.025,
    cacheCreationPer1M: 0,
  },
};

const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5.4 (M5.5+ creative)
  "gpt-5.4": {
    inputPer1M: 10,
    outputPer1M: 30,
    cacheReadPer1M: 2.5,
    cacheCreationPer1M: 0,
  },
};

/** Fallback when a model isn't in our table — Haiku-tier pricing so mock
 * cost estimates don't blow up assertions. Clearly stubby. */
const FALLBACK_PRICING: ModelPricing = {
  inputPer1M: 0.5,
  outputPer1M: 1.5,
  cacheReadPer1M: 0.05,
  cacheCreationPer1M: 0.625,
};

export function pricingFor(model: string): ModelPricing {
  return (
    ANTHROPIC_PRICING[model] ?? GOOGLE_PRICING[model] ?? OPENAI_PRICING[model] ?? FALLBACK_PRICING
  );
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
