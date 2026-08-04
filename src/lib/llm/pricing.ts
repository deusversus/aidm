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
 * read = 0.1× input; write = 1.25× input at the 5-minute TTL, 2× at the
 * 1-hour TTL. Inter-turn breakpoints all write at 1h (C9, measured
 * 2026-07-18: no live inter-turn gap fits 5 minutes); the 5m rate returned
 * with M2R5 C2's in-process loops, whose rounds are seconds apart.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read input tokens. */
  cacheReadPer1M: number;
  /** USD per 1M cache-creation input tokens at the 5-minute TTL (1.25×). */
  cacheCreation5mPer1M: number;
  /** USD per 1M cache-creation input tokens at the 1-hour TTL (2×). */
  cacheCreationPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": {
    inputPer1M: 10,
    outputPer1M: 50,
    cacheReadPer1M: 1,
    cacheCreation5mPer1M: 12.5,
    cacheCreationPer1M: 20,
  },
  "claude-opus-5": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheCreation5mPer1M: 6.25,
    cacheCreationPer1M: 10,
  },
  // Off the menus since 2026-07-25 (Opus 5 supersedes, same rates) — kept so
  // historical rows and fixtures still meter instead of throwing.
  "claude-opus-4-8": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheCreation5mPer1M: 6.25,
    cacheCreationPer1M: 10,
  },
  // List price; an intro rate ($2/$10) runs through 2026-08-31 — we meter
  // at list, a deliberate over-estimate that self-corrects in September.
  "claude-sonnet-5": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheCreation5mPer1M: 3.75,
    cacheCreationPer1M: 6,
  },
  "claude-haiku-4-5": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheCreation5mPer1M: 1.25,
    cacheCreationPer1M: 2,
  },
  // Voyage bills input tokens only (embeddings have no output tokens).
  "voyage-3.5": {
    inputPer1M: 0.06,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheCreation5mPer1M: 0,
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

/** The API's per-TTL creation split (`usage.cache_creation`). */
export interface CacheCreationSplit {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /**
   * Per-TTL creation breakdown, when the response carried one. Absent means
   * "unknown", not "zero" — historical rows and fixtures predate M2R5 C2 and
   * price flat at the 1h rate below.
   */
  cache_creation?: CacheCreationSplit;
  /**
   * Billable server-side web searches (`usage.server_tool_use
   * .web_search_requests`, M3R3 C2). The per-search fee is real spend the
   * token fields cannot see — dropping it here would ship an unmetered
   * organ (the choke-point doctrine forbids exactly that).
   */
  web_search_requests?: number;
}

/**
 * Web search server-tool fee: $10 per 1,000 searches (verified live against
 * platform.claude.com docs 2026-08-04; errored searches are not billed and
 * never reach the usage counter).
 */
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;

/** Compute total USD cost for a given model + usage breakdown. */
export function estimateCostUsd(model: string, usage: UsageStats): number {
  const p = pricingFor(model);
  const inputCost = (usage.input_tokens / 1_000_000) * p.inputPer1M;
  const outputCost = (usage.output_tokens / 1_000_000) * p.outputPer1M;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheReadPer1M;
  // A 5m write costs 1.25×, a 1h write 2× — pricing every write at 2× turned
  // M2R5 C2's short-loop writes into phantom overcharges on the ledger. The
  // split is trusted ONLY when it is finite and sums to the flat total beside
  // it: on the streamed path the SDK updates the flat counter from
  // message_delta but never the nested split, so a drifted or partial split
  // must lose to the flat 1h rate — a NaN here doesn't misprice a row, it
  // THROWS at the numeric insert and the row is lost (C2 audit).
  const flat = usage.cache_creation_input_tokens ?? 0;
  const split = usage.cache_creation;
  const splitSane =
    split !== undefined &&
    Number.isFinite(split.ephemeral_5m_input_tokens) &&
    Number.isFinite(split.ephemeral_1h_input_tokens) &&
    split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens === flat;
  const cacheCreationCost =
    split !== undefined && splitSane
      ? (split.ephemeral_5m_input_tokens / 1_000_000) * p.cacheCreation5mPer1M +
        (split.ephemeral_1h_input_tokens / 1_000_000) * p.cacheCreationPer1M
      : (flat / 1_000_000) * p.cacheCreationPer1M;
  const searchCost = (usage.web_search_requests ?? 0) * WEB_SEARCH_USD_PER_SEARCH;
  return inputCost + outputCost + cacheReadCost + cacheCreationCost + searchCost;
}
