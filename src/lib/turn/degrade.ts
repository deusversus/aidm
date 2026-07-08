/**
 * The degrade ladder (blueprint §5.5). Doctrine: quality outranks latency —
 * the ladder catches WASTE (stalls, runaway loops), never trims deliberate
 * depth. It fires only when the Phase-A wall-clock budget is blown, in a
 * fixed order, logging every step to the trace.
 */

export const LADDER_STEPS = [
  "skip_validation_retry",
  "timebox_pacer",
  "cap_research_2",
  "cap_research_0",
  "drop_to_genga",
  "minimal_brief",
] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];

export interface LadderState {
  /** Steps fired so far, in order. */
  fired: LadderStep[];
  /** Brief flagged degraded (§5.5 step 5) — Gauge excludes these turns. */
  degraded: boolean;
}

/**
 * Overrun thresholds: rung N fires when elapsed exceeds budget × threshold.
 * Escalation is proportional to how blown the budget is — a mildly-late
 * turn only skips its validation retry; only a catastrophically stalled one
 * reaches the §5.5 terminal fallback (minimal brief, degraded flag). Every
 * rung is reachable at any stage boundary; none fire on a healthy turn.
 */
export const RUNG_OVERRUN: Record<LadderStep, number> = {
  skip_validation_retry: 1.0,
  timebox_pacer: 1.2,
  cap_research_2: 1.4,
  cap_research_0: 1.6,
  drop_to_genga: 1.9,
  minimal_brief: 2.4,
};

export interface DegradeClock {
  /** ms since Phase A began. */
  elapsed(): number;
  /** The tier's Phase-A budget in ms. */
  budgetMs: number;
  state: LadderState;
  /** True when the NEXT un-fired rung's overrun threshold is crossed. */
  shouldDegrade(): boolean;
  /** Fire the next step; returns the step or null when exhausted. */
  fire(): LadderStep | null;
  has(step: LadderStep): boolean;
}

export function createDegradeClock(
  budgetMs: number,
  onStep: (step: LadderStep, elapsedMs: number) => void,
  now: () => number = Date.now,
): DegradeClock {
  const started = now();
  const state: LadderState = { fired: [], degraded: false };
  return {
    budgetMs,
    state,
    elapsed: () => now() - started,
    shouldDegrade() {
      const next = LADDER_STEPS[state.fired.length];
      if (!next) return false;
      return now() - started > budgetMs * RUNG_OVERRUN[next];
    },
    fire() {
      const next = LADDER_STEPS[state.fired.length];
      if (!next) return null;
      state.fired.push(next);
      if (next === "minimal_brief") state.degraded = true;
      onStep(next, now() - started);
      return next;
    },
    has(step) {
      return state.fired.includes(step);
    },
  };
}

/**
 * Phase-A wall-clock budgets per tier. Doctrine (§5.5): the ladder catches
 * WASTE — stalls, runaway loops — never deliberate depth. A single healthy
 * judgment call at high effort runs 10-20s, so budgets sit well above the
 * healthy path (the live probe tripped a 12s genga budget on a normal
 * turn — mistuned, not malfunctioning). Tunable defaults; the C10 soak
 * asserts and calibrates them.
 */
export const PHASE_A_BUDGET_MS: Record<string, number> = {
  douga: 8_000,
  genga: 35_000,
  sakuga: 70_000,
};
