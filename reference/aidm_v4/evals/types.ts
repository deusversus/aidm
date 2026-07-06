import { z } from "zod";

/**
 * Eval harness types (Commit 8) — Zod schemas for golden-turn fixtures
 * + result records.
 *
 * A GoldenFixture encodes one scenario: the player message + the
 * expected shape of the turn the pipeline should produce. Deterministic
 * assertions (intent exact-match, outcome bounds, narrative regex)
 * run on every CI run. A separate `manual_rubric` block is consumed
 * ONLY by the `--judge` manual review flow Claude invokes locally
 * with the user's explicit approval — never in CI.
 */

export const ExpectedIntent = z.object({
  intent: z.enum(["DEFAULT", "COMBAT", "SOCIAL", "EXPLORATION", "ABILITY", "META_FEEDBACK"]),
  action: z.string().optional(),
  epicness_min: z.number().min(0).max(1).optional(),
  epicness_max: z.number().min(0).max(1).optional(),
  special_conditions: z.array(z.string()).optional(),
});
export type ExpectedIntent = z.infer<typeof ExpectedIntent>;

export const ExpectedOutcomeBounds = z
  .object({
    // Only enforced when pre-judge fires (see `shouldPreJudgeOutcome`
    // in src/lib/workflow/turn.ts). Low-epicness turns skip OJ, so the
    // outcome can be null — that's fine; pre-judge-optional fixtures
    // leave this block absent.
    //
    // narrative_weight is categorical in v4 (MINOR / SIGNIFICANT / CLIMACTIC).
    // success_level is one of: critical_failure | failure | partial_success
    //                          | success | critical_success.
    narrative_weight_one_of: z.array(z.enum(["MINOR", "SIGNIFICANT", "CLIMACTIC"])).optional(),
    success_level_one_of: z
      .array(
        z.enum(["critical_failure", "failure", "partial_success", "success", "critical_success"]),
      )
      .optional(),
    rationale_non_empty: z.boolean().optional(),
  })
  .optional();
export type ExpectedOutcomeBounds = z.infer<typeof ExpectedOutcomeBounds>;

export const ExpectedNarrativeDeterministic = z.object({
  /** Entity names the narrative MUST reference (case-insensitive substring). */
  must_include_entity: z.array(z.string()).default([]),
  /** Phrases the narrative MUST NOT contain (case-insensitive substring). */
  must_not_include: z.array(z.string()).default([]),
  min_length_chars: z.number().int().positive().default(1),
  max_length_chars: z.number().int().positive().default(10_000),
});
export type ExpectedNarrativeDeterministic = z.infer<typeof ExpectedNarrativeDeterministic>;

export const ManualRubric = z
  .object({
    register: z.array(z.string()).default([]),
    tone_anchors: z.array(z.string()).default([]),
    forbidden_patterns: z.array(z.string()).default([]),
    judge_threshold_note: z.string().optional(),
  })
  .optional();
export type ManualRubric = z.infer<typeof ManualRubric>;

export const GoldenFixture = z.object({
  id: z.string(),
  description: z.string().default(""),
  /** Profile slug — must match a file under `evals/golden/profiles/<slug>.yaml`. */
  profile_slug: z.string(),
  /** Character preset key — inline here; full sheet embedded below. */
  character: z.object({
    name: z.string(),
    concept: z.string(),
    power_tier: z.string(),
    sheet: z.record(z.string(), z.unknown()).default({}),
  }),
  last_turns_summary: z.string().default(""),
  input: z.object({
    player_message: z.string().min(1),
  }),
  expected_intent: ExpectedIntent,
  expected_outcome_bounds: ExpectedOutcomeBounds,
  expected_narrative_deterministic: ExpectedNarrativeDeterministic,
  /** Manual-review-only. Never checked in CI. */
  manual_rubric: ManualRubric,
  /** Directory relative to repo root containing MockLLM fixtures for this scenario. */
  mockllm_fixture_dir: z.string(),
});
export type GoldenFixture = z.infer<typeof GoldenFixture>;

// ---------------------------------------------------------------------------
// Result records — per-scenario + aggregate
// ---------------------------------------------------------------------------

export const DeterministicChecks = z.object({
  intentExact: z.boolean(),
  intentActual: z.string(),
  epicnessActual: z.number().nullable(),
  epicnessInRange: z.boolean(),
  outcomeInBounds: z.boolean(),
  outcomeNarrativeWeight: z.string().nullable(),
  outcomeSuccessLevel: z.string().nullable(),
  narrativeMustIncludeMissing: z.array(z.string()),
  narrativeMustNotIncludeHit: z.array(z.string()),
  narrativeLengthOk: z.boolean(),
  narrativeLength: z.number(),
});
export type DeterministicChecks = z.infer<typeof DeterministicChecks>;

export const JudgeScore = z.object({
  register_adherence: z.number().min(1).max(5),
  tone_coherence: z.number().min(1).max(5),
  specificity: z.number().min(1).max(5),
  causal_logic: z.number().min(1).max(5),
  voice_fit: z.number().min(1).max(5),
  rationale: z.string(),
});
export type JudgeScore = z.infer<typeof JudgeScore>;

export const EvalResult = z.object({
  id: z.string(),
  passed: z.boolean(),
  narrative: z.string(),
  deterministic: DeterministicChecks,
  /** Present only when `--judge` was passed (manual review only). */
  judge: JudgeScore.optional(),
  error: z.string().optional(),
});
export type EvalResult = z.infer<typeof EvalResult>;

export const EvalSummary = z.object({
  ranAt: z.string(),
  commit: z.string().optional(),
  mode: z.enum(["ci", "local", "judge"]),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  scenarios: z.array(EvalResult),
});
export type EvalSummary = z.infer<typeof EvalSummary>;
