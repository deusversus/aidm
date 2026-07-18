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
  /** Opportunistic turn-to-turn hit rate assumed until M2 telemetry (§5.6).
   *  M1 soak MEASURED 0.24 mean on a young campaign (B3 dominates while
   *  B1+B2 are thin; improves as compaction fills cached B2) — the 0.7
   *  assumption stands as the mature-campaign target, telemetry at M2. */
  assumedCacheHitRate: 0.7,
  /** Uncached per-turn tail: the conte + player input (Block 4). */
  dynamicTokensPerTurn: 3_000,
} as const;

/**
 * Adaptive thinking bills as OUTPUT and the original cost model omitted it —
 * the M1 soak measured every genga/sakuga ceiling breach tracing to thinking
 * spend, not prose (§3: thinking depth is deliberate, so it belongs in the
 * model, not in a widened margin). Measured allowances, M1 soak run #3.
 */
export const THINKING_ALLOWANCE_TOKENS: Record<TurnTier, number> = {
  douga: 1_000,
  // Recalibrated from live telemetry 2026-07-11 (C8): genga p95 5296 / max
  // 7548; sakuga p95 14695 / max 15488 — allowances cover p95 with margin.
  genga: 6_000,
  sakuga: 16_000,
};

/**
 * Per-turn dollar ceilings at the most expensive menu model, COLD.
 * Recalibrated 2026-07-11: C10 folded the thinking allowances above into the
 * model (correctly — thinking depth is deliberate spend) but left these at
 * their pre-thinking values, so the gate went red on the commit that improved
 * the model (genga modeled $0.68 vs a $0.55 ceiling; CI red for 7 pushes).
 * Ceilings sit ~10% over the honest cold model — regression-catching margin,
 * never quality headroom (§0: budgets catch waste, never trim depth).
 */
export const COLD_TURN_CEILING_USD: Record<TurnTier, number> = {
  // C9 re-set: the 1h-TTL decision raises every cold write from 1.25x to
  // 2x input (measured think-time made 5m worthless — see pricing.ts), so
  // the honest cold model rose to douga $0.65 / genga $0.93 / sakuga $1.77
  // at Fable. Ceilings sit ~10% over — regression margin, never headroom.
  // The EXPECTED per-turn cost falls despite this: 1h caching converts
  // most real turns from full-prefix rewrites into 0.1x reads.
  douga: 0.72,
  genga: 1.05,
  sakuga: 1.95,
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
  const out = contract.outputBudgetTokens + THINKING_ALLOWANCE_TOKENS[tier];
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
