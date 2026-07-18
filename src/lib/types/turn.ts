import { z } from "zod";

/**
 * Turn vocabulary: the salvaged v4 probe/judgment output schemas plus the
 * v5 turn-contract table (blueprint §5.1).
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
 */
export const TURN_CONTRACTS: Record<TurnTier, TurnContract> = {
  douga: {
    tier: "douga",
    retrievalCandidates: 0,
    retrievalCap: 0,
    canonFanOut: false,
    consultants: [],
    kaResearchCalls: 0,
    outputBudgetTokens: 600,
    promptBudgetTokens: 30_000,
    ttftTargetMs: 3_000,
    totalTargetMs: 10_000,
    validationRetry: false,
    effort: "low",
  },
  genga: {
    tier: "genga",
    retrievalCandidates: 6,
    retrievalCap: 5,
    canonFanOut: false,
    consultants: ["outcome", "pacer"],
    kaResearchCalls: 2,
    outputBudgetTokens: 1_200,
    promptBudgetTokens: 30_000,
    ttftTargetMs: 8_000,
    totalTargetMs: 35_000,
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
    outputBudgetTokens: 2_000,
    promptBudgetTokens: 45_000,
    ttftTargetMs: 15_000,
    totalTargetMs: 60_000,
    validationRetry: true,
    effort: "xhigh",
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
