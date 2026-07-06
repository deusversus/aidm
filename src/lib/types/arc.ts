import { z } from "zod";
import { ArcShape, PartialComposition } from "./composition";
import { PartialDNAScales } from "./dna";

/**
 * Arc override — Director's transient partial deviation from the campaign's
 * active premise (blueprint §4.2).
 *
 * Lifecycle:
 *   - Director sets a single arc_override when an arc needs a temporary
 *     tonal or framing shift. Invariant: AT MOST ONE active override; a new
 *     one replaces the old (latest wins).
 *   - Effective premise = { ...active, ...arc_override } (partials carry
 *     only the axes Director explicitly shifted).
 *   - While an override is active, the Compositor runs one probe-tier check
 *     per turn: "did this scene cross the transition signal?" On yes the
 *     override clears, active takes back over, and an Amendments update is
 *     enqueued for the next turn. Worst-case lag: one turn.
 */
export const ArcOverride = z.object({
  arc_name: z.string().min(1),
  started_turn: z.number().int().nonnegative(),
  /** Prose event that closes the override and returns to active_* state. */
  transition_signal: z.string().min(1),
  dna: PartialDNAScales.optional(),
  composition: PartialComposition.optional(),
});

export type ArcOverride = z.infer<typeof ArcOverride>;

// ---------------------------------------------------------------------------
// The Arc Model (§7.3) — "arc" was pulling too much weight; it decomposes
// into typed, nested strata. The Director plans top-down; the Pacer
// executes bottom-up.
// ---------------------------------------------------------------------------

export const ArcStratum = z.enum(["beat", "scene", "episode", "arc", "season", "series"]);
export type ArcStratum = z.infer<typeof ArcStratum>;

/**
 * Budget: length is one stratification of arc, denominated per stratum.
 * Story-first doctrine (§7.3): arc length is dictated by the story, never
 * by the sitting. Sources: premise genre defaults → rule-library shape
 * priors → Director judgment within tolerance. Season stratum defaults to
 * one cour (~12 episodes); two-cour seasons plan a mid-season climax.
 */
export const ArcBudget = z.object({
  unit: z.enum(["scenes", "episodes"]),
  target: z.number().int().positive(),
  tolerance: z.number().int().nonnegative(),
});
export type ArcBudget = z.infer<typeof ArcBudget>;

/**
 * What must be true at close: seeds resolved or consciously carried, the
 * dramatic question answered or deliberately deferred. Payoff debt =
 * unresolved items vs remaining budget — one of §7.3's objectively
 * measurable quantities.
 */
export const PayoffContractItem = z.object({
  description: z.string().min(1),
  seed_ids: z.array(z.string()).default([]),
  status: z.enum(["open", "resolved", "carried", "deferred"]),
});

export const PayoffContract = z.array(PayoffContractItem);
export type PayoffContract = z.infer<typeof PayoffContract>;

/**
 * Canon-weight tag (§7.3, Special/OVA mode): a special may run canon-light —
 * seeds don't fire, consequences don't scar, what happens in the special
 * stays in the special — or full-canon. Declared up front by the Director
 * when framing the one-shot.
 */
export const CanonWeight = z.enum(["full_canon", "canon_light"]);
export type CanonWeight = z.infer<typeof CanonWeight>;

/**
 * The arc object, any stratum (§7.3). `shape` compiles to an expected
 * tension curve (rising = climb to climax at ~80% of budget; waves = peaks
 * and troughs; plateau = flat with texture; falling = decline; fragmented =
 * episodic spikes over a slow throughline) — the curve compilation is
 * Director machinery (M1), not schema.
 *
 * `phase` vocabulary is finalized with the Pacer's stall tables at M1
 * (phase overstay = turns_in_phase vs gate thresholds); a free string keeps
 * the M0 schema from inventing gate names the Pacer doesn't use.
 */
export const ArcObject = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stratum: ArcStratum,
  /** Descends from the spark at high strata (§8). */
  dramatic_question: z.string().min(1),
  shape: ArcShape,
  budget: ArcBudget,
  phase: z.string().min(1),
  payoff_contract: PayoffContract,
  status: z.enum(["planned", "active", "closing", "closed", "abandoned"]),
  canon_weight: CanonWeight.default("full_canon"),
  parent_id: z.string().optional(),
});

export type ArcObject = z.infer<typeof ArcObject>;
