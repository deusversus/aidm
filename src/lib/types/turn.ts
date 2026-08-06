import { z } from "zod";

/**
 * Turn vocabulary: the salvaged v4 probe/judgment output schemas plus the
 * v5 turn-contract table (blueprint §5.1).
 *
 * THE BOUNDS BELOW ARE PROTECTIVE, AND THEY STAY (M3, 2026-08-01). The
 * structured-output grammar strips `.min()`/`.max()` on strings, arrays and
 * numbers — they validate client-side only — so elsewhere in the codebase such
 * a bound is a DESTROY-CLASS defect: it cannot constrain the model, and its
 * only effect is to fail the parse and take a single-shot artifact down with
 * it (the sidecar trailer, a Director cycle, a G2 distill, a booth
 * resolution). Those were removed and replaced with prompt text + a consumer
 * clamp.
 *
 * IntentOutput and OutcomeOutput are the deliberate exception, on two counts.
 * (1) The failure has somewhere to land: both run under callStructured's
 * corrective retry and then a caller degrade ladder (triage falls back to
 * genga; the outcome judgment retries then degrades), so a rejected parse
 * costs a retry, never the turn. (2) Rejection is the POINT — the
 * difficulty_class band exists so a hallucinated `difficulty_class: 999` is
 * refused rather than clamped into a plausible-looking 30 and written into the
 * permanent turn record. A silently pinned die roll is worse than a re-rolled
 * one. Do not "sweep" these into clamps.
 */

export const IntentType = z.enum([
  "DEFAULT",
  "COMBAT",
  "SOCIAL",
  "EXPLORATION",
  "ABILITY",
  "INVENTORY",
  "WORLD_BUILDING",
  "META_FEEDBACK",
  "OVERRIDE_COMMAND",
  "OP_COMMAND",
]);

/**
 * Coerce null → undefined for optional string fields. Haiku (and Opus)
 * sometimes emits `null` when the prompt says "omit when unknown".
 * Prod log 2026-04-23 turn 9 showed the intent probe wasting a retry
 * attempt on `target: null`. Keep the prompt honest + survive slips
 * gracefully.
 */
const nullableOptionalString = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.string().optional(),
);

/** Phase-A parse output — the intent probe IS the triage call (§5.1). */
export const IntentOutput = z.object({
  intent: IntentType,
  target: nullableOptionalString,
  action: nullableOptionalString,
  epicness: z.number().min(0).max(1),
  special_conditions: z.array(z.string()).default([]),
  /**
   * §5.4 authorship detection (M2 C2, ratified 2026-07-10): a single text is
   * often action AND authorship at once — the mid-battle scream that mints
   * "the monster has a master" is COMBAT carrying new canon. Orthogonal to
   * intent; fires on ANY channel. Default false keeps pre-C2 records parsing.
   */
  contains_world_assertion: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  // Same null→undefined guard as target/action above: Haiku emits null for
  // "omit when unknown" (live layout probe, 2026-07-07).
  secondary_intent: z.preprocess((v) => (v === null ? undefined : v), IntentType.optional()),
});

export type IntentOutput = z.infer<typeof IntentOutput>;

export const NarrativeWeight = z.enum(["MINOR", "SIGNIFICANT", "CLIMACTIC"]);
export type NarrativeWeight = z.infer<typeof NarrativeWeight>;

export const SuccessLevel = z.enum([
  "critical_failure",
  "failure",
  "partial_success",
  "success",
  "critical_success",
]);
export type SuccessLevel = z.infer<typeof SuccessLevel>;

/**
 * Outcome judgment output. Carries v3's full doctrine (§5.1): virtual d20,
 * anime-logic modifiers, costs-rare-not-default, and the power-differential
 * floor. "Failure must never be the engine defending its plot — and stories
 * only end intentionally, never at the behest of a die-roll" (§7.5).
 */
export const OutcomeOutput = z.object({
  success_level: SuccessLevel,
  // D&D-ish bound. Prompt documents 1–30; Zod enforces it so a
  // hallucinated "difficulty_class: 999" fails parse and triggers
  // retry/fallback rather than poisoning the turn record.
  difficulty_class: z.number().int().min(1).max(30),
  modifiers: z.array(z.string()).default([]),
  narrative_weight: NarrativeWeight,
  consequence: z.string().optional(),
  cost: z.string().optional(),
  rationale: z.string(),
});

export type OutcomeOutput = z.infer<typeof OutcomeOutput>;

/** Sakuga sub-modes (§5.1 ladder, carried v3-verbatim in lib/ka/sakuga.ts). */
export const SakugaMode = z.enum(["choreographic", "frozen_moment", "aftermath", "montage"]);
export type SakugaMode = z.infer<typeof SakugaMode>;

// ---------------------------------------------------------------------------
// Turn tiers and contracts (§5.1)
// ---------------------------------------------------------------------------

/**
 * Register vocabulary (§16): douga = in-betweens (trivial), genga = key
 * frames (standard), sakuga = full-budget peak scenes (heavy).
 */
export const TurnTier = z.enum(["douga", "genga", "sakuga"]);
export type TurnTier = z.infer<typeof TurnTier>;

/** Effort tiers the turn engine requests from the model call (§3). */
export type TurnEffort = "low" | "high" | "xhigh";

export interface TurnContract {
  tier: TurnTier;
  /** ANN+keyword candidates fetched before the relevance filter. 0 = critical block only. */
  retrievalCandidates: number;
  /** Post-filter cap entering the conte. */
  retrievalCap: number;
  /** Sakuga adds the canon-layer fan-out to retrieval. */
  canonFanOut: boolean;
  consultants: readonly ("outcome" | "pacer" | "scale" | "validation")[];
  /** Budgeted KA research round-trips during Phase B. */
  kaResearchCalls: number;
  outputBudgetTokens: number;
  /** Prompt input budget across blocks 1–4. */
  promptBudgetTokens: number;
  ttftTargetMs: number;
  totalTargetMs: number;
  /** One validation retry allowed — sakuga-tier only by default. */
  validationRetry: boolean;
  effort: TurnEffort;
}

/**
 * §5.1 contract table. All numbers are tunable defaults asserted in soak
 * runs (§10.8) — none are sacred.
 *
 * Caveat (recorded in §3): narratively trivial ≠ functionally trivial. The
 * Pacer's beat classification promotes effort on build-up scenes (escalation
 * beats run ≥ "high") so sakuga's masterstroke build-ups are never starved.
 * That promotion lives in the Pacer (M1), not this table.
 *
 * Effort is FLAT at "high" across all three tiers (§3 amendment, user-ruled
 * 2026-08-01). Effort participates in the prompt-cache key (wire-measured
 * 2026-07-26): the old ladder (douga low / sakuga xhigh) bought a full cold
 * ~25k-token prefix re-write at every tier boundary, and the playtest measured
 * genga-at-high running warm at $0.38/turn while sakuga-at-xhigh opened cold
 * every time. "high" is the API default and still thinks deeply; xhigh's
 * quality delta was designed-in, never measured. It earns its seat back only
 * through a blind A/B (two sakuga scenes, both efforts, read cold).
 */
export const TURN_CONTRACTS: Record<TurnTier, TurnContract> = {
  douga: {
    tier: "douga",
    retrievalCandidates: 0,
    retrievalCap: 0,
    canonFanOut: false,
    consultants: [],
    kaResearchCalls: 0,
    outputBudgetTokens: 900,
    promptBudgetTokens: 30_000,
    // FLAT-HIGH-ERA NUMBERS, and they look absurd on purpose. 3,000/10,000
    // were written when douga ran effort "low"; the §3 flatten (2026-08-01)
    // put the trivial tier on "high", and the N=50 soak (2026-08-05) measured
    // what that means: across 14 douga turns, TTFT p90 102.8s and total p90
    // 132.5s, with TTFT tracking thinking almost linearly (≈ 8s + thinking/84
    // tok/s — the wait IS the reasoning, not latency to fix). Against the dead
    // 3s target every one of those turns flagged twice: 28 of the run's 105
    // latency flags were unactionable BY CONSTRUCTION, which is worse than no
    // target at all — a tripwire that always fires stops being read.
    // Set at p90 + ~15%: in the measured run these flag exactly one turn
    // (turn 17, 141s/162s), which is what a tripwire is supposed to do.
    // THESE REVERT IF DOUGA'S EFFORT DOES. The §3 amendment is user-ruled and
    // flat high stands until a blind A/B says otherwise; a douga-at-low ruling
    // would put the old 3s/10s back within a run.
    ttftTargetMs: 120_000,
    totalTargetMs: 160_000,
    validationRetry: false,
    effort: "high",
  },
  genga: {
    tier: "genga",
    retrievalCandidates: 6,
    retrievalCap: 5,
    canonFanOut: false,
    consultants: ["outcome", "pacer"],
    kaResearchCalls: 2,
    outputBudgetTokens: 1_800,
    promptBudgetTokens: 30_000,
    // RE-BASELINED from the N=50 soak (2026-08-05), the same measurement and
    // the same arithmetic that moved douga above (p90 + ~15%, rounded). 8s/35s
    // were aspirational M1-era markers that no genga turn has ever met: across
    // 26 genga narration steps the run measured
    //   TTFT  (N=25, one re-anchored step never observed its first token):
    //         p50 55.2s · p90 89.4s · p95 94.1s · max 102.2s
    //   TOTAL (N=26): p50 81.4s · p90 120.5s · p95 122.0s · max 132.5s
    // and flagged 25 of 25 TTFTs and 24 of 26 totals — 49 of the run's 105
    // latency flags, unactionable BY CONSTRUCTION against a dead letter (77 of
    // them were, counting sakuga's 28 below). A tripwire that always fires
    // stops being read, which is worse than no tripwire.
    // MEASURED ON SONNET (the soak runs DEV_TIER_SELECTION — Fable narration
    // is player-facing spend, never automated). These are therefore
    // Sonnet-measured numbers standing in for the tier; a Fable-served genga
    // turn is unmeasured and would very likely sit slower, so this is the
    // conservative direction to be wrong in.
    ttftTargetMs: 105_000,
    totalTargetMs: 140_000,
    validationRetry: false,
    effort: "high",
  },
  sakuga: {
    tier: "sakuga",
    retrievalCandidates: 9,
    retrievalCap: 5,
    canonFanOut: true,
    consultants: ["outcome", "pacer", "scale", "validation"],
    kaResearchCalls: 4,
    outputBudgetTokens: 3_000,
    promptBudgetTokens: 45_000,
    // RE-BASELINED from the same N=50 soak, and the N IS SMALL — say it beside
    // every number. Across 14 sakuga narration steps:
    //   TTFT  (N=14): p50 68.3s · p90 110.2s · p95 113.6s (= max)
    //   TOTAL (N=14): p50 93.4s · p90 125.9s · p95 145.6s (= max)
    // The old 15s/60s flagged all 14 turns twice — 28 more dead-letter flags,
    // which with genga's 49 is 77 of the run's 105 retired by this re-baseline.
    // p90 + ~15% lands at 126.7s / 144.8s; both round UP (130s / 150s) rather
    // than down, deliberately: fourteen samples do not support fitting a
    // ceiling to the tail, and §0's rule is that a budget catches waste and
    // never trims deliberate depth — a target that fails a legitimately deep
    // sakuga turn is trimming depth. At these numbers the measured run flags
    // nothing, which is the honest consequence of calibrating to p90 on a
    // short tail; the tripwire's job here is the REGRESSION, not the run it
    // was calibrated from.
    // MEASURED ON SONNET (DEV_TIER_SELECTION), like genga's above — and sakuga
    // is the tier most likely to be served by Fable in real play, so these
    // stand in for a Fable distribution nobody has measured yet. They move
    // when a Fable-served sakuga turn is measured, the same condition the
    // 16k thinking allowance waits on (evals/suites/budget-assertions.ts).
    ttftTargetMs: 130_000,
    totalTargetMs: 150_000,
    validationRetry: true,
    effort: "high",
  },
};

/**
 * Triage thresholds (§5.1): douga when epicness < 0.3 with no
 * combat/social/ability intent, no special-condition flags, and neither
 * genga floor active (the cold open and escalation/climax arc phases both
 * floor at genga — triage.ts). Sakuga when epicness ≥ 0.7, combat, or
 * flags; genga is the default. The triage decision itself is the Phase-A
 * probe's output — these constants keep the numbers in one home.
 */
export const TRIAGE_THRESHOLDS = {
  // C9 calibration (39 live+soak turns, persisted epicness, 2026-07-18):
  // the probe's emitted floor is 0.2 — douga at <0.2 was STRUCTURALLY
  // unreachable (zero douga in the whole corpus; every ash-tap and
  // rain-watching beat routed genga). At <0.3 the hand-labeled routine
  // class (emitted 0.2-0.25) routes douga while the mixed 0.3 band
  // (substantive turns emit 0.3 too) stays genga. The probe anchors
  // (layout INTENT_SYSTEM) teach the routine class toward 0.1-0.2.
  dougaMaxEpicness: 0.3,
  sakugaMinEpicness: 0.7,
} as const;
