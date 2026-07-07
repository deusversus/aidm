import { estimateCostUsd } from "@/lib/llm/pricing";
import { TIER_MENUS } from "@/lib/llm/tiers";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.8 — cost/latency budget assertions, with the cache-hit assumption
 * and cold-turn cost EXPLICIT so cache regressions fail loudly instead of
 * drifting. At M0 this validates the cost model against the §5.1 table and
 * pricing; from M1 the soak runs feed real per-turn usage through
 * `assertTurnCost`.
 *
 * All numbers are tunable defaults (§5.1 doctrine) — first-pass ceilings,
 * asserted so a change is a diff, not a drift.
 */

export const BUDGET_ASSUMPTIONS = {
  /** Opportunistic turn-to-turn hit rate assumed until M2 telemetry (§5.6). */
  assumedCacheHitRate: 0.7,
  /** Uncached per-turn tail: the conte + player input (Block 4). */
  dynamicTokensPerTurn: 3_000,
} as const;

/** Per-turn dollar ceilings at the most expensive menu model, COLD. */
export const COLD_TURN_CEILING_USD: Record<TurnTier, number> = {
  douga: 0.45,
  genga: 0.55,
  sakuga: 1.0,
};

export interface TurnCostModel {
  coldUsd: number;
  warmUsd: number;
  expectedUsd: number;
}

/** Model a turn's narration-call cost for a tier at a given model. */
export function turnCostModel(
  tier: TurnTier,
  model: string,
  assumptions = BUDGET_ASSUMPTIONS,
): TurnCostModel {
  const contract = TURN_CONTRACTS[tier];
  const prefix = Math.max(0, contract.promptBudgetTokens - assumptions.dynamicTokensPerTurn);
  const out = contract.outputBudgetTokens;
  const coldUsd = estimateCostUsd(model, {
    input_tokens: assumptions.dynamicTokensPerTurn,
    output_tokens: out,
    cache_creation_input_tokens: prefix,
  });
  const warmUsd = estimateCostUsd(model, {
    input_tokens: assumptions.dynamicTokensPerTurn,
    output_tokens: out,
    cache_read_input_tokens: prefix,
  });
  const expectedUsd =
    warmUsd * assumptions.assumedCacheHitRate + coldUsd * (1 - assumptions.assumedCacheHitRate);
  return { coldUsd, warmUsd, expectedUsd };
}

/** M1+ soak hook: assert one real turn's metered cost against the model. */
export function assertTurnCost(tier: TurnTier, actualUsd: number): string | null {
  const ceiling = COLD_TURN_CEILING_USD[tier];
  return actualUsd <= ceiling
    ? null
    : `${tier} turn cost $${actualUsd.toFixed(4)} exceeds cold ceiling $${ceiling}`;
}

export const budgetAssertions: Suite = {
  name: "budget-assertions",
  gate: "M0 (cost model) → M1+ (soak-fed)",
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];
    for (const tier of ["douga", "genga", "sakuga"] as const) {
      for (const model of TIER_MENUS.narration) {
        const m = turnCostModel(tier, model);
        details.push(
          `${tier}/${model}: cold $${m.coldUsd.toFixed(4)} warm $${m.warmUsd.toFixed(4)} expected $${m.expectedUsd.toFixed(4)}`,
        );
        if (m.warmUsd >= m.coldUsd) {
          failures.push(`${tier}/${model}: warm ≥ cold — cache math inverted`);
        }
      }
      // The ceiling is asserted at the priciest menu model — if Fable cold
      // fits, everything fits.
      const worst = turnCostModel(tier, "claude-fable-5");
      const breach = assertTurnCost(tier, worst.coldUsd);
      if (breach) failures.push(breach);
    }
    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
