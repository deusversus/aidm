import { z } from "zod";
import { ArcBudget, PayoffContract } from "./arc";
import { ArcShape } from "./composition";

export { ArcBudget, PayoffContract } from "./arc";

/**
 * Direction contracts (blueprint §7, C7): the Director's typed output, the
 * Pacer's full directive, and the engine-side DirectionState that persists
 * trigger accumulators + session-frozen artifacts in campaigns.direction_state.
 *
 * The numeric tables here are v3's PLAY-TESTED values, carried verbatim
 * (reference/aidm_v3/prompts/pacing.md, src/core/_background.py,
 * src/core/foreshadowing.py) — do not retune without evidence.
 */

// --- Phases + stall tables (v3 pacing.md, verbatim) --------------------------

export const PACER_PHASES = [
  "setup",
  "rising",
  "escalation",
  "climax",
  "falling",
  "resolution",
] as const;
export const PacerPhase = z.enum(PACER_PHASES);
export type PacerPhase = z.infer<typeof PacerPhase>;

export interface PhaseGate {
  /** turns_in_phase strictly greater → strength "strong" admitted. */
  strongAfter: number;
  strongAction: string;
  /** turns_in_phase strictly greater → strength "override" admitted (axiom 3). */
  overrideAfter?: number;
  overrideAction?: string;
}

/** v3's stall table — override is NEVER admitted below these thresholds. */
export const PHASE_GATES: Record<PacerPhase, PhaseGate> = {
  setup: {
    strongAfter: 6,
    strongAction: "Nudge toward rising",
    overrideAfter: 10,
    overrideAction: "Force transition to rising",
  },
  rising: {
    strongAfter: 8,
    strongAction: "Begin escalation",
    overrideAfter: 12,
    overrideAction: "Force escalation/climax",
  },
  escalation: {
    strongAfter: 6,
    strongAction: "Push toward climax",
    overrideAfter: 10,
    overrideAction: "Force climax",
  },
  climax: {
    strongAfter: 4,
    strongAction: "Begin falling",
    overrideAfter: 8,
    overrideAction: "Force falling",
  },
  falling: { strongAfter: 6, strongAction: "Move to resolution" },
  resolution: { strongAfter: 4, strongAction: "Transition to next arc" },
};

/** v3's escalation-target bands per phase (tension the beat should aim at). */
export const ESCALATION_BANDS: Record<PacerPhase, { min: number; max: number }> = {
  setup: { min: 0.0, max: 0.2 },
  rising: { min: 0.2, max: 0.5 },
  escalation: { min: 0.5, max: 0.8 },
  climax: { min: 0.8, max: 1.0 },
  falling: { min: 0.3, max: 0.5 },
  resolution: { min: 0.0, max: 0.3 },
};

/** tension > this while NOT in climax → the Pacer suggests climax at "strong". */
export const TENSION_CLIMAX_SUGGEST = 0.8;

// --- Director cadence (v3 _background.py, verbatim) --------------------------

export const DIRECTOR_MIN_TURNS_BETWEEN = 3;
export const DIRECTOR_EPICNESS_THRESHOLD = 2.0;
export const DIRECTOR_MAX_INTERVAL = 8;
/** Overdue seeds push tension: bump = overdueCount * this, tension capped at 1. */
export const OVERDUE_TENSION_BUMP = 0.05;
/** Investigation loop budget (§7.1; v3 ran 4 — the blueprint grants 6). */
export const DIRECTOR_MAX_TOOL_ROUNDS = 6;

// --- Seeds (v3 foreshadowing.py, verbatim) -----------------------------------

export const SEED_MIN_TURNS_TO_PAYOFF = 5;
export const SEED_MAX_TURNS_TO_PAYOFF = 50;
export const SEED_DEFAULT_URGENCY = 0.5;
export const SEED_MENTION_URGENCY_BUMP = 0.1;

// --- Arc model (§7.3) ---------------------------------------------------------

/** Register-derived season default: one cour. Two-cour plans a mid-season climax. */
export const COUR_EPISODES = 12;

// --- Session lifecycle (§9.4) --------------------------------------------------

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ROLLING_CHECKPOINT_TURNS = 12;

// --- DirectionState (engine-only; campaigns.direction_state) -------------------

export const PhaseState = z.object({
  arc_id: z.string(),
  phase: PacerPhase,
  /** Turn the phase was entered; turns_in_phase = turnNumber − this. Reset
   *  ONLY by the Director (v3: pacer suggests, director disposes). */
  entered_at_turn: z.number().int().nonnegative(),
});
export type PhaseState = z.infer<typeof PhaseState>;

export const PilotPlan = z.object({
  cold_open_constraints: z.array(z.string()).default([]),
  /** Pass-through from the OSP's animation_inputs — hard constraints for turn 1. */
  forbidden_opening_moves: z.array(z.string()).default([]),
  opening_pov: z.string().optional(),
  first_arc_question: z.string().optional(),
  /** Layout flips this after injecting into turn 1's conte (idempotent replay). */
  consumed: z.boolean().default(false),
});
export type PilotPlan = z.infer<typeof PilotPlan>;

export const SceneShapeBase = z.object({
  trajectory_note: z.string().optional(),
  /** Director notes ride the Scene-Shape Directive (§7.1 advisory channel). */
  notes: z.array(z.string()).default([]),
});
export type SceneShapeBase = z.infer<typeof SceneShapeBase>;

/** Session-frozen Settei snapshot (§4.4a): Block 1 renders from THIS, not from
 *  live marks — mid-session marks ride Amendments until the next session-open
 *  rebuild bakes them. Without the freeze, every G2 mark write would silently
 *  bust the Block-1 prefix cache (§5.6). */
export const SetteiSnapshot = z.object({
  text: z.string(),
  charter_tokens: z.number().int().nonnegative(),
  rendered_axes: z.array(z.string()).default([]),
  uncovered_extremes: z.array(z.string()).default([]),
  /** Marks with turnId > this ride Amendments; ≤ this are baked in. */
  rebuilt_at_turn: z.number().int().nonnegative(),
  rebuilt_at: z.string(),
});
export type SetteiSnapshot = z.infer<typeof SetteiSnapshot>;

export const DirectionState = z.object({
  last_director_turn: z.number().int().nonnegative().default(0),
  accumulated_epicness: z.number().nonnegative().default(0),
  /** Since the last Director run: level_up | sakuga_moment | boss_defeat |
   *  foreshadowing_mentioned | phase_transition_suggested:<phase> | … */
  arc_events: z.array(z.string()).default([]),
  tension_level: z.number().min(0).max(1).default(0.3),
  phase_state: PhaseState.optional(),
  /** Director-supplied secondary axis ranking for the Settei (frozen per session). */
  arc_relevance: z.record(z.string(), z.number()).optional(),
  scene_shape: SceneShapeBase.optional(),
  pilot_plan: PilotPlan.optional(),
  director_notes: z.array(z.string()).default([]),
  voice_patterns: z.array(z.string()).default([]),
  /** §7.1 spotlight output — Layout surfaces these as conte spotlight_hints. */
  spotlight_directives: z.array(z.object({ name: z.string(), note: z.string() })).default([]),
  /** Ingestion FLAGs routed to the Director (layout writes, dailies consume). */
  pending_flags: z.array(z.string()).default([]),
  settei: SetteiSnapshot.optional(),
});
export type DirectionState = z.infer<typeof DirectionState>;

// --- Director output (model-facing; strict structured output) ------------------
// Flat where a union would be cleaner: strict output schemas stay closed and
// simple (no discriminated unions, no records) — the engine re-shapes.

export const DirectorArcPlan = z.object({
  name: z.string().min(1),
  dramatic_question: z.string().min(1),
  shape: ArcShape,
  budget: ArcBudget,
  phase: PacerPhase,
  payoff_contract: PayoffContract.default([]),
  status: z.enum(["active", "closing", "closed"]),
});
export type DirectorArcPlan = z.infer<typeof DirectorArcPlan>;

export const DirectorSeedOp = z.object({
  op: z.enum(["plant", "resolve", "abandon"]),
  /** plant: the new seed's description. */
  description: z.string().optional(),
  expected_payoff: z.string().optional(),
  payoff_window_from: z.number().int().optional(),
  payoff_window_to: z.number().int().optional(),
  /** plant: descriptions of seeds gating this one (matched to ids engine-side). */
  dependencies: z.array(z.string()).default([]),
  /** resolve/abandon: match against the existing seed's description. */
  seed_description: z.string().optional(),
  reason: z.string().optional(),
});
export type DirectorSeedOp = z.infer<typeof DirectorSeedOp>;

/**
 * DirectorOutput stays LEAN on optionals by design: the strict-output grammar
 * compiler rejects schemas with >24 optional parameters (caught by the C7
 * live probe — embedding PartialDNAScales/PartialComposition in arc_override
 * put the count at 43 and 400'd every cycle). Premise shifts are expressed as
 * axis/value PAIRS; the engine converts to the stored ArcOverride partials.
 * Always-emitted arrays are REQUIRED (the model writes [] explicitly).
 */
export const DirectorOutput = z.object({
  /** Investigation digest — internal, never player-facing (axiom 2). */
  analysis: z.string(),
  tension_level: z.number().min(0).max(1),
  phase: PacerPhase,
  arc_plan: DirectorArcPlan,
  /** Delimit a story movement: closes an episode row under the active arc. */
  episode_close: z
    .object({ name: z.string().min(1), dramatic_question: z.string().min(1) })
    .optional(),
  arc_override: z
    .object({
      arc_name: z.string().min(1),
      transition_signal: z.string().min(1),
      /** DNA axis shifts, e.g. {axis:"darkness", value:8}. Invalid axes drop engine-side. */
      dna_shifts: z.array(z.object({ axis: z.string(), value: z.number().min(0).max(10) })).max(6),
      /** Framing enum shifts, e.g. {axis:"arc_shape", value:"falling"}. */
      composition_shifts: z.array(z.object({ axis: z.string(), value: z.string() })).max(4),
    })
    .optional(),
  clear_override: z.boolean(),
  scene_shape_trajectory: z.string().optional(),
  scene_shape_notes: z.array(z.string()).max(3),
  arc_relevance: z
    .array(z.object({ axis: z.string(), relevance: z.number().min(1).max(9) }))
    .max(6),
  seed_ops: z.array(DirectorSeedOp).max(6),
  spotlight_directives: z.array(z.object({ name: z.string(), note: z.string() })).max(3),
  /** Dailies (§6.3 size review): critical facts to demote, matched on content. */
  demote_criticals: z.array(z.string()).max(5),
  director_notes: z.array(z.string()).max(5),
  voice_patterns: z.array(z.string()).max(5),
});
export type DirectorOutput = z.infer<typeof DirectorOutput>;

export interface DirectorTrigger {
  fire: boolean;
  reasons: string[];
}

// --- Pacer (full, §7.2) ---------------------------------------------------------

export interface PacerArcState {
  phase: PacerPhase;
  turnsInPhase: number;
  tensionLevel: number;
  arcName?: string;
  shape?: string;
}

/** Model-facing directive; strength is PROPOSED — code clamps via PHASE_GATES. */
export const PacerDirective = z.object({
  beat_classification: z.string().min(1),
  escalation_target: z.string().optional(),
  tone: z.string().optional(),
  must_reference: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  foreshadowing_hint: z.string().optional(),
  strength: z.enum(["suggestion", "strong", "override"]),
  pacing_note: z.string().optional(),
  /** Engine-facing: recorded as an arc event for the Director; never applied. */
  phase_transition: PacerPhase.optional(),
});
export type PacerDirective = z.infer<typeof PacerDirective>;
