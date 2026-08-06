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
 *
 * THE LATENCY HALF OF §10.8 LIVES IN `TURN_CONTRACTS` (types/turn.ts):
 * `ttftTargetMs` / `totalTargetMs` per tier, asserted per turn by the soak
 * harness (scripts/soak-lib.ts). All three tiers were re-baselined against the
 * N=50 flat-high soak — douga at the M3 close (60c799b), genga and sakuga at
 * M3R4 B1 — with the measured distributions inline there. This file owns the
 * dollars and the cache assumption; that one owns the clock.
 */

export const BUDGET_ASSUMPTIONS = {
  /** Turn-to-turn cache-read rate — MEASURED 0.715 (N=50 soak, 2026-08-05;
   *  one run, n=1, the mean of the per-turn turn-to-turn read fraction over
   *  51 metered turns). It was an ASSUMPTION from M0 until this run: M1's
   *  soak measured 0.24 on a young campaign, M2R5 C3 moved B3 to
   *  per-exchange blocks with a moving tail breakpoint, and a two-call wire
   *  probe at C3's landing showed 99.1% on a single warm mid-session turn —
   *  none of which was an engine-wide rate. The 50-turn run is: 0.715 across
   *  cold opens, a session-open Settei rebuild, three compaction resets and a
   *  rewind, which are exactly the events that dilute it.
   *  The number HOLDS at 0.7 — the measurement landed inside the assumption
   *  rather than moving it, and one run is not enough to tighten a
   *  denominator that every projected price divides by. `pnpm cache:gauge`
   *  stays the running measure. NOTE the scope: this grades the turn's FIRST
   *  narration call only. Within-turn follow-ups are a different meter (§5.6
   *  guaranteed read; soak-lib's WITHIN-turn floor). */
  assumedCacheHitRate: 0.7,
  /** Uncached per-turn tail: the conte + player input (Block 4). */
  dynamicTokensPerTurn: 3_000,
} as const;

/**
 * KNOWN UNDER-MODEL, still recorded rather than papered over (32k window
 * ruling, user 2026-08-05). The prefix below is derived from §5.1's
 * `promptBudgetTokens` (genga 30k), and the verbatim window alone may now
 * carry 32k — so on a mature, token-heavy campaign the modeled cold cost sits
 * under the real one. The flat-high soak (N=50, 2026-08-05) has now run and
 * re-baselined the allowances, the tier mix and the call count below; it did
 * NOT re-baseline §5.1's prompt budgets, because a soak measures what the
 * engine spends, not what the table should say. Raising §5.1's numbers is
 * still a blueprint change, not an eval tweak — this note stays until it is
 * one. The measured evidence: the run's largest observed narration prompt was
 * 44,892 tokens on a genga turn against a 30k budget.
 */

/**
 * Adaptive thinking bills as OUTPUT and the original cost model omitted it —
 * the M1 soak measured every genga/sakuga ceiling breach tracing to thinking
 * spend, not prose (§3: thinking depth is deliberate, so it belongs in the
 * model, not in a widened margin).
 */
export const THINKING_ALLOWANCE_TOKENS: Record<TurnTier, number> = {
  // RE-BASELINED from the first flat-high soak (N=50, 2026-08-05), which is
  // the run the 6k interim was explicitly waiting on. 14 douga turns ran at
  // flat "high": thinking p95 8,884, max 10,006 (turn 17 produced 10,678
  // output tokens against a 900-token prose budget). The interim borrowed
  // genga's 6k on the theory that a deeper tier's allowance over-models a
  // trivial one; measurement says the opposite — at flat high the DOUGA beat
  // thinks longest, because a trivial prompt gives adaptive thinking nothing
  // to converge on. 10,000 covers p95 with the +13% margin genga's own
  // calibration uses.
  douga: 10_000,
  // HOLDS. Live telemetry 2026-07-11 (C8) gave p95 5,296 / max 7,548; the
  // N=50 flat-high soak measured p95 5,235 across 22 genga turns — the same
  // number twice, one calibration apart.
  genga: 6_000,
  // HOLDS, and KNOWN OVER-MODEL, recorded rather than tightened: the N=50 run
  // measured 5,415 on SONNET across 12 sakuga turns, and this allowance is
  // applied to FABLE in the ceiling below. A cross-model tightening is not a
  // measurement — Fable's thinking depth at the same effort is unmeasured, and
  // the original 16k came from real sakuga telemetry (p95 14,695 / max 15,488,
  // at xhigh). It moves when a Fable-served sakuga turn is measured, not
  // before.
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
  // RE-BASELINED whole, against `turnCostModel` at Fable, N=50 soak
  // 2026-08-05. Two things moved at once and BOTH had to, or this commit
  // turns CI red on itself: douga's thinking allowance (6k → 10k, above) and
  // the model's call count (one call → the scene round plus its contracted
  // research round-trips). Ceilings sit ~10% over the honest cold model —
  // regression margin, never quality headroom (§0: budgets catch waste, never
  // trim depth; a ceiling that fails a legitimate deep turn trims depth).
  //
  // Arithmetic, at Fable ($10/M in · $50/M out · $20/M 1h cache write ·
  // $1/M cache read), prefix = promptBudget − 3,000, tail = the uncached
  // conte re-processed per call plus what the turn has produced by then:
  //
  //   douga  1 call:  in 3,000 ($0.030) + out 10,900 ($0.545)
  //                 + write 27,000 ($0.540)                       = $1.115
  //   genga  3 calls: in 16,800 ($0.168) + out 7,800 ($0.390)
  //                 + write 27,000 ($0.540) + read 54,000 ($0.054) = $1.152
  //   sakuga 5 calls: in 53,000 ($0.530) + out 19,000 ($0.950)
  //                 + write 42,000 ($0.840) + read 168,000 ($0.168) = $2.488
  //
  // Douga is unchanged in SHAPE (it contracts zero research calls, so the
  // multi-call model reduces to the old single-call one) and moves only
  // because the allowance did. Genga and sakuga move because the old model
  // could not describe them at all: the soak asserted a summed 2-call genga
  // turn against a single-call ceiling and read the sum as a cost breach
  // (turn 24, $0.3431 vs $0.2880 — part real waste, part this).
  douga: 1.23,
  genga: 1.27,
  sakuga: 2.74,
};

export interface TurnCostModel {
  coldUsd: number;
  warmUsd: number;
  expectedUsd: number;
}

/**
 * Model a TURN's narration cost for a tier at a given model — all of it, not
 * one call of it.
 *
 * A turn is not one narration call. §5.1's contract budgets `kaResearchCalls`
 * research round-trips (genga 2, sakuga 4), each a real API request inside the
 * same Phase B, and the soak sums them before asserting. Modelling one call
 * and asserting a sum against it is structurally wrong, and it produced a
 * false breach on the N=50 run (turn 24).
 *
 * The shape, derived from the wire rather than assumed:
 *  - THE PREFIX is written once (cold) or read once (warm), then READ by every
 *    follow-up — post-M3R4 the follow-ups hold the scene round's tool posture,
 *    so they hit the entry the scene round just created (turn 8 of the soak: a
 *    research round read 14,572, exactly the 13,245 + 1,327 before it).
 *  - THE TAIL is uncached on every call, by design: the conte is Block 4 and
 *    sits after the last breakpoint, so each call re-processes it at 1x — and
 *    a follow-up also re-reads what the turn has produced so far, thinking
 *    blocks included (turn 24: call 2's input was 13,203 = call 1's 6,586 plus
 *    its 6,571 of output). Modelled as the mean over the turn's calls.
 *  - PRODUCTION is counted ONCE. The allowances above are measured per TURN,
 *    so a follow-up adds prompt cost, never a second scene's worth of output.
 *
 * NOT modelled: the §5.7 trailer continuation, which any turn may fire on top
 * of its contracted rounds. Left out deliberately rather than silently — it is
 * a net, not a budget, and the N=50 run priced its worst real firing at $0.216
 * (Fable-repriced, douga turn 17), inside the ~10% ceiling margin. If it ever
 * stops fitting there, it belongs in `calls` below, not in a widened ceiling.
 */
export function turnCostModel(
  tier: TurnTier,
  model: string,
  assumptions = BUDGET_ASSUMPTIONS,
): TurnCostModel {
  const contract = TURN_CONTRACTS[tier];
  const prefix = Math.max(0, contract.promptBudgetTokens - assumptions.dynamicTokensPerTurn);
  const out = contract.outputBudgetTokens + THINKING_ALLOWANCE_TOKENS[tier];
  // The scene round plus the contracted research round-trips. douga budgets
  // none, so its model reduces exactly to the pre-M3R4 single-call one.
  const calls = 1 + contract.kaResearchCalls;
  // calls × the conte, plus the mean of the turn's own output re-read by each
  // follow-up: Σ(k=1..calls-1) out·k/calls  =  out·(calls−1)/2.
  const tail = assumptions.dynamicTokensPerTurn * calls + (out * (calls - 1)) / 2;
  const coldUsd = estimateCostUsd(model, {
    input_tokens: tail,
    output_tokens: out,
    cache_creation_input_tokens: prefix,
    cache_read_input_tokens: prefix * (calls - 1),
  });
  const warmUsd = estimateCostUsd(model, {
    input_tokens: tail,
    output_tokens: out,
    cache_read_input_tokens: prefix * calls,
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
