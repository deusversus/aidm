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

// --- §7.6 two-path detection (M3 C2) -----------------------------------------

/**
 * Organic detection (§7.6): cosine between a turn's narration and an active
 * seed's description at or above this is a CANDIDATE — not a mention. The
 * blueprint sets the number; the sweep that applies it is pure code.
 */
export const ORGANIC_CANDIDATE_THRESHOLD = 0.55;

/** Two seeds this mutually similar are a CONVERGENCE candidate (§7.6, pure code). */
export const SEED_CONVERGENCE_SIMILARITY = 0.7;

/** Convergence pairs rendered in the dossier — the Director reads the strongest few. */
export const SEED_CONVERGENCE_MAX_PAIRS = 5;

/**
 * Candidate entries kept per seed row. The sweep appends one per matching
 * turn; the ledger must not grow a per-turn tail over a 100-turn season, so
 * the oldest fall off. Adjudicated entries stay (convergence reads the whole
 * window); only un-adjudicated ones cost a judged call.
 */
export const SEED_MAX_CANDIDATES = 12;

/**
 * Below this the batched adjudicator's state-changing verdicts (payoff,
 * conflict, extend) are recorded as evidence-free and dropped: an auto-resolve
 * or an auto-abandon on a hedge is the engine deciding the story on a coin
 * flip, and §7.5's chisel forbids exactly that. Mentions are cheap and
 * reversible, so they ride the same floor for simplicity, not for safety.
 */
export const SEED_ADJUDICATION_MIN_CONFIDENCE = 0.6;

/**
 * The §7.6 cost law made structural: the batched call renders ONLY seeds under
 * review — pending candidates, callback-ready seeds carrying an expected
 * payoff, and overdue conflict-suspects — never the ledger. These are the
 * per-bucket ceilings; the ledger may hold a hundred seeds and the call still
 * costs the same.
 */
export const SEED_ADJUDICATION_CAPS = {
  candidates: 12,
  callback_ready: 8,
  conflict_suspects: 6,
  /** Narrated fragments rendered as the shared evidence window. */
  evidence_turns: 12,
} as const;

/**
 * One organic-sweep hit, stored compactly on the seed row (see schema.ts for
 * why the row and not DirectionState). `t` is the turn whose narration
 * matched, `s` the cosine at the sweep, `adj` set once a batched adjudication
 * has already read it — the cost law depends on never re-judging a candidate.
 */
export const SeedCandidate = z.object({
  t: z.number().int().nonnegative(),
  s: z.number(),
  adj: z.boolean().optional(),
});
export type SeedCandidate = z.infer<typeof SeedCandidate>;

/** Tolerant read of the seeds.candidates jsonb — a malformed entry drops, never throws. */
export function parseCandidates(raw: unknown): SeedCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: SeedCandidate[] = [];
  for (const entry of raw) {
    const parsed = SeedCandidate.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const SEED_VERDICTS = ["mention", "payoff", "conflict", "extend", "none"] as const;
export type SeedVerdictKind = (typeof SEED_VERDICTS)[number];

/**
 * The verdict vocabulary, taken as a lean string and normalized here (M3R4
 * R-1). ENUM VOCABULARY IS NOT GRAMMAR — measured against the SDK's
 * `transformJSONSchema`, a `z.enum` is demoted to `type: "string"` plus a
 * `{enum: [...]}` DESCRIPTION, so the model is advised, never constrained.
 * ADJUDICATOR_SYSTEM spells the verdicts as prose capitals ("MENTION — the
 * scene genuinely surfaced this seed") and the model answered in kind: 13 of
 * 18 adjudication calls in the N=50 soak died on `"MENTION"` vs `"mention"`,
 * taking every other verdict in the batch with them. Case is not a judgment
 * error and must never cost a batch — trim, lowercase, and let anything still
 * unrecognized fall to `none`, the verdict that does nothing.
 */
export function normalizeSeedVerdict(raw: string): SeedVerdictKind {
  const token = raw.trim().toLowerCase();
  return (SEED_VERDICTS as readonly string[]).includes(token) ? (token as SeedVerdictKind) : "none";
}

/**
 * One verdict from the batched adjudication (§7.6). NO RANGE BOUNDS — same
 * grammar law as DirectorOutput: `minimum`/`maximum` are stripped by the
 * strict-output compiler, so a bound here could only fail the parse and throw
 * away every OTHER verdict in the batch. The limits are stated in the prompt
 * and applied by `clampAdjudication`.
 */
export const SeedVerdict = z.object({
  /** Index into the rendered under-review list; out-of-range refs drop engine-side. */
  seed_ref: z.number().int(),
  /** Lean by design — see {@link normalizeSeedVerdict}. The description IS the
   *  model's only statement of the vocabulary, so it names the exact tokens. */
  verdict: z
    .string()
    .describe('one of: "mention" | "payoff" | "conflict" | "extend" | "none" (lowercase)'),
  /** 0-1; clamped engine-side. */
  confidence: z.number(),
  /** One sentence from the evidence naming why. */
  evidence: z.string(),
  /** verdict="extend" only: the new payoff-window `to` turn. */
  new_window_to: z.number().int().optional(),
});
export type SeedVerdict = z.infer<typeof SeedVerdict>;

/** A verdict after {@link normalizeSeedVerdict} — what the engine acts on. */
export type AdjudicatedVerdict = Omit<SeedVerdict, "verdict"> & { verdict: SeedVerdictKind };

export const SeedAdjudication = z.object({ verdicts: z.array(SeedVerdict) });
export type SeedAdjudication = z.infer<typeof SeedAdjudication>;

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
  /**
   * The charter shipped over §4.4a's ceiling even after every trim (M3 C1).
   * Recorded so the overrun is visible to the Director and the dailies
   * instead of dying in the renderer's local trim list.
   */
  charter_over_target: z.boolean().default(false),
  rendered_axes: z.array(z.string()).default([]),
  uncovered_extremes: z.array(z.string()).default([]),
  /** Marks with turnId > this ride Amendments; ≤ this are baked in. */
  rebuilt_at_turn: z.number().int().nonnegative(),
  rebuilt_at: z.string(),
});
export type SetteiSnapshot = z.infer<typeof SetteiSnapshot>;

// --- Sakkan drift-band state (§4.5, C8 — engine-only) --------------------------

/** One axis's latest blind reading + its consecutive-drift counter. */
export const SakkanReading = z.object({
  observed: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  at_turn: z.number().int().nonnegative(),
  /** Consecutive samples in drift (≥ DRIFT_THRESHOLD at ≥ DRIFT_CONFIDENCE). */
  consecutive_drift: z.number().int().nonnegative(),
  evidence: z.string().default(""),
});
export type SakkanReading = z.infer<typeof SakkanReading>;

/** An active corrective note (a retake, §16) — the Amendments producer. */
export const SakkanActiveNote = z.object({
  axis: z.string(),
  /** The value the premise wants (effective: active ⊕ arc_override, §4.2). */
  active: z.number().min(0).max(10),
  observed: z.number().min(0).max(10),
  since_turn: z.number().int().nonnegative(),
});
export type SakkanActiveNote = z.infer<typeof SakkanActiveNote>;

/**
 * The gate-trip attribution read (§4.5 M2R3 — the drift band gains sight of the
 * PLAYER without gaining sight of the DIALS): once a retake trips, one blind
 * judgment probe classifies who is driving the divergence. `player_driven` and
 * `narrator_driven` are the poles; `entangled` is routed conservatively (like
 * narrator). See sakkan/attribution.ts — the probe never sees a premise value.
 */
export const DRIVER_CLASSES = ["player_driven", "narrator_driven", "entangled"] as const;
export const DriverClass = z.enum(DRIVER_CLASSES);
export type DriverClass = z.infer<typeof DriverClass>;

export const AttributionResult = z.object({
  driver: DriverClass,
  /** One sentence, from the player inputs, naming why. */
  evidence: z.string(),
});
export type AttributionResult = z.infer<typeof AttributionResult>;

/**
 * A drift the gate-trip attribution charged to the PLAYER (§0 authority
 * ordering: player word outranks premise-truth). The retake is CLOSED — the
 * engine stops silently straining against the player — and this rides the
 * Director's next dossier as a first-class steering-honesty item (§7.1/§8/§4.2).
 * Keyed by axis in SakkanState.player_driven; cleared when the axis reads back
 * in band (the drift resolved — by an accepted §4.2 evolution, or by play
 * returning home on its own). `wanted` is the effective-premise value the story
 * SET (active ⊕ override); the Director and the player notice read it — the
 * Sakkan's blind SCORER never does (blindness is scoped to scoring, §4.5).
 */
export const PlayerDrivenDrift = z.object({
  axis: z.string(),
  observed: z.number().min(0).max(10),
  wanted: z.number().min(0).max(10),
  evidence: z.string().default(""),
  at_turn: z.number().int().nonnegative(),
});
export type PlayerDrivenDrift = z.infer<typeof PlayerDrivenDrift>;

export const SakkanState = z.object({
  last_sample_turn: z.number().int().nonnegative().default(0),
  /** Per-axis observed record — with canonical/active read from the contract,
   *  this IS the §12 canonical/active/observed record (data only at M1). */
  readings: z.record(z.string(), SakkanReading).default({}),
  active_notes: z.array(SakkanActiveNote).default([]),
  /**
   * §4.5 M2R3 — axes whose drift the gate-trip attribution charged to the
   * player. Keyed by axis. The retake is closed (never opened); the finding
   * rides the Director's next dossier. Cleared when the axis reads back in band.
   */
  player_driven: z.record(z.string(), PlayerDrivenDrift).default({}),
  /** §4.5 Voice checklist (M2R4): per-dimension adherence from the latest
   *  sample — the fingerprint measured, not vibed. Keyed by dimension name. */
  voice_readings: z
    .record(
      z.string(),
      z.object({ score: z.number(), evidence: z.string(), at_turn: z.number().int() }),
    )
    .default({}),
  /** Composed pressure line when voice runs sustained-weak; the Amendments
   *  render it so the correction reaches the pen (M2R4). */
  voice_pressure: z.string().optional(),
});
export type SakkanState = z.infer<typeof SakkanState>;

/**
 * §4.5 M2R3 steering-honesty notice: set when the Director applies a §4.2
 * arc_override that ANSWERS a player-driven drift finding. The play surface
 * reads it on next load and shows ONE quiet, dismissible line (the
 * assertion-notice family, never a modal); dismissing clears it. `observed` is
 * where play ran; `set` is the premise value it ran against — both surface in
 * the line ("runs [observed] against the premise's [set]"). Once per override.
 */
export const SteeringNotice = z.object({
  axis: z.string(),
  observed: z.number().min(0).max(10),
  set: z.number().min(0).max(10),
  at_turn: z.number().int().nonnegative(),
});
export type SteeringNotice = z.infer<typeof SteeringNotice>;

// --- §7.1 evolution ratification (M3 C4) --------------------------------------

/**
 * "Sustained" for the season-boundary EVOLUTION REVIEW: this many consecutive
 * drifting samples on the axis. The drift band already calls TWO consecutive
 * samples drifting and opens a retake (§4.5 DRIFT_CONSECUTIVE); ratification
 * asks the player to change the premise PERMANENTLY, so it costs one sample
 * more than a correction does — the same bar the Learned layer pays before it
 * writes a pencil mark (MARK_CONSECUTIVE): this is calibration, not a streak.
 */
export const EVOLUTION_SUSTAINED_SAMPLES = 3;

/**
 * The depth branch: |observed − wanted| ≥ this on a single axis is material by
 * itself. Mirrors §4.5's DRIFT_THRESHOLD — under two points the two readings
 * are the same story told twice, and no story is "becoming something better
 * than its premise" one point at a time.
 */
export const EVOLUTION_AXIS_DELTA = 2;

/**
 * The breadth branch: this many axes drifting player-ward at once is material
 * whatever each one's depth. A story pulled sideways on two axes is not the
 * same story — that reading is exactly what §7.1's review exists for.
 */
export const EVOLUTION_MIN_AXES = 2;

/**
 * A §7.1 evolution proposal, raised at a SEASON boundary only and awaiting the
 * player's word. It amends NOTHING on its own: it sits on direction_state
 * until the play surface's card is answered — "Make it canon" amends the
 * ACTIVE premise layer permanently (§4.2) and dates a note into the bible;
 * "Pull it home" plants retakes on the same axes. Silence persists the card;
 * ratification is EXPLICIT, and an unanswered proposal never expires into a
 * yes. Distinct from M2R3's steering_notice, which stays the IN-SEASON channel
 * (any cycle, arc_override only, dismissible, silence is consent).
 */
/**
 * The critical-facts category a ratified retooling files under. Its writer is
 * direction/evolution.ts's ratify answer; its readers are the Series Bible's
 * own retooling section (bible.ts) and — like every critical fact — the layer-9
 * guaranteed injection, because a season the player re-authored is standing
 * truth the writer keeps.
 */
export const EVOLUTION_CATEGORY = "evolution";

export const EvolutionAxisShift = z.object({
  axis: z.string(),
  /** The ACTIVE layer's value today — what ratification overwrites. */
  from: z.number().min(0).max(10),
  /** Where the season actually played, per the Director's proposal. */
  to: z.number().min(0).max(10),
});
export type EvolutionAxisShift = z.infer<typeof EvolutionAxisShift>;

export const EvolutionProposal = z.object({
  /** The season stratum row whose boundary raised this. */
  season_id: z.string(),
  season_name: z.string().default(""),
  proposed_at_turn: z.number().int().nonnegative(),
  /** The Director's own paragraph, in the fiction's language — shown VERBATIM. */
  director_case: z.string(),
  axes: z.array(EvolutionAxisShift),
});
export type EvolutionProposal = z.infer<typeof EvolutionProposal>;

/**
 * A janitor-detected near-duplicate pair the machine won't auto-merge (§6.5,
 * M2 C1). Confidence sits between the suggest and auto thresholds; resolution
 * is player word only. survivor/dupe orientation is the janitor's proposal —
 * survivor keeps the row, dupe tombstones into it.
 */
export const MergeSuggestion = z.object({
  survivor_id: z.string().uuid(),
  dupe_id: z.string().uuid(),
  survivor_name: z.string(),
  dupe_name: z.string(),
  entity_type: z.string(),
  /** One sentence for the notes panel: why the janitor thinks they're the same. */
  reason: z.string(),
  /** The probe's same-entity confidence (suggest band: below auto, above noise). */
  confidence: z.number().min(0).max(1),
  at_turn: z.number().int().nonnegative(),
});
export type MergeSuggestion = z.infer<typeof MergeSuggestion>;

export const DirectionState = z.object({
  last_director_turn: z.number().int().nonnegative().default(0),
  /** M3R2 C1: stamped at cycle START (before the emit can fail). A failed
   *  cycle backs off DIRECTOR_MIN_TURNS_BETWEEN turns instead of refiring
   *  every turn — the live grammar-400 ratchet burned 37 doomed calls
   *  because only SUCCESS ever reset the trigger accumulators. */
  last_director_attempt: z.number().int().nonnegative().optional(),
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
  /**
   * §6.5 janitor output (M2 C1): ambiguous near-duplicate pairs the machine
   * won't auto-merge — surfaced to the player in the notes panel, resolved
   * only by player word (accept → merge:player, dismiss → dropped). Cleared
   * when either entity is tombstoned; rewind clamps by at_turn.
   */
  merge_suggestions: z.array(MergeSuggestion).default([]),
  settei: SetteiSnapshot.optional(),
  /** §4.5 drift band (C8): readings, counters, active retakes. */
  sakkan: SakkanState.optional(),
  /**
   * §4.5 M2R3 — a pending steering-honesty notice for the play surface, set by
   * the Director when it applies an override answering a player-driven drift.
   * The play view shows one quiet dismissible line on next load; dismiss clears
   * it (the DELETE steering-notice route). Absent = nothing to show.
   */
  steering_notice: SteeringNotice.optional(),
  /**
   * §7.1 (M3 C4) — a season-boundary evolution proposal awaiting the player's
   * word. Raised by the Director cycle only when the evidence gate is open;
   * cleared ONLY by the two answers (ratify / pull home). Absent = nothing to
   * ask, which is the overwhelmingly common case: an author who keeps asking
   * permission has no voice.
   */
  evolution_proposal: EvolutionProposal.optional(),
  /** One review per season, whatever the answer (C4 audit MUST-FIX: a spent
   *  season reads "boundary" forever, and without this stamp a DECLINED
   *  proposal re-asks every cycle — the anxious check-in §7.1 forbids). */
  last_evolution_review: z.object({ season_id: z.string(), turn: z.number().int() }).optional(),
  /** Ratified shifts with their FROM values — the rewind substrate's undo
   *  record (C4 audit: the bible note tombstones on rewind but the amended
   *  contract survived; this ledger makes the amendment revocable, §6.7). */
  evolution_history: z
    .array(
      z.object({
        season_id: z.string(),
        turn: z.number().int(),
        axes: z.array(z.object({ axis: z.string(), from: z.number(), to: z.number() })),
      }),
    )
    .default([]),
});
export type DirectionState = z.infer<typeof DirectionState>;

/**
 * Rewind DirectionState to turn N (§6.7 — turns are revocable; C8 re-audit).
 * Turn-anchored fields clamp to the surviving timeline and dead-timeline
 * evidence drops; without this, a rewind left last_sample_turn /
 * last_director_turn pointing past the tip — silently disabling the Sakkan
 * (the same-turn guard) and the Director trigger (negative turns_since)
 * until play re-passed the pre-rewind high-water mark. Accumulators reset:
 * their evidence may reference un-happened turns. Soft prose state (notes,
 * tension, pilot plan) survives — the next Director cycle re-plans it.
 * Pure; the rewind transaction applies it atomically with the sweep.
 */
export function rewindDirectionState(state: DirectionState, toTurn: number): DirectionState {
  return {
    ...state,
    last_director_turn: Math.min(state.last_director_turn, toTurn),
    ...(state.last_director_attempt !== undefined
      ? { last_director_attempt: Math.min(state.last_director_attempt, toTurn) }
      : {}),
    accumulated_epicness: 0,
    arc_events: [],
    // Suggestions referencing un-happened turns die with the dead timeline;
    // their entity ids may point at rows the rewind sweep just tombstoned.
    merge_suggestions: state.merge_suggestions.filter((s) => s.at_turn <= toTurn),
    ...(state.phase_state
      ? {
          phase_state: {
            ...state.phase_state,
            entered_at_turn: Math.min(state.phase_state.entered_at_turn, toTurn),
          },
        }
      : {}),
    ...(state.settei
      ? {
          settei: {
            ...state.settei,
            rebuilt_at_turn: Math.min(state.settei.rebuilt_at_turn, toTurn),
          },
        }
      : {}),
    ...(state.sakkan
      ? {
          sakkan: {
            last_sample_turn: Math.min(state.sakkan.last_sample_turn, toTurn),
            readings: Object.fromEntries(
              Object.entries(state.sakkan.readings).filter(([, r]) => r.at_turn <= toTurn),
            ),
            active_notes: state.sakkan.active_notes.filter((n) => n.since_turn <= toTurn),
            // Player-driven findings anchored past the surviving tip die with
            // the dead timeline — their evidence references un-happened inputs.
            player_driven: Object.fromEntries(
              Object.entries(state.sakkan.player_driven).filter(([, f]) => f.at_turn <= toTurn),
            ),
            // Voice readings likewise; the pressure line always recomputes at
            // the next sample, so a rewind simply clears it (M2R4).
            voice_readings: Object.fromEntries(
              Object.entries(state.sakkan.voice_readings).filter(([, r]) => r.at_turn <= toTurn),
            ),
            voice_pressure: undefined,
          },
        }
      : {}),
    // A steering notice raised on a now-un-happened override drops (the
    // override write itself reverts under the rewind sweep).
    ...(state.steering_notice && state.steering_notice.at_turn > toTurn
      ? { steering_notice: undefined }
      : {}),
    // Likewise a proposal raised on a season boundary that no longer happened:
    // its whole case argues from turns the rewind just un-wrote.
    ...(state.last_evolution_review && state.last_evolution_review.turn > toTurn
      ? { last_evolution_review: undefined }
      : {}),
    evolution_history: (state.evolution_history ?? []).filter((e) => e.turn <= toTurn),
    ...(state.evolution_proposal && state.evolution_proposal.proposed_at_turn > toTurn
      ? { evolution_proposal: undefined }
      : {}),
  };
}

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

/**
 * The seed lifecycle vocabulary (§7.6). `adjust_window` was planned in C1 and
 * slipped: without it the Director's only way to give a seed more room was to
 * plant a near-duplicate, so the original never left the ledger and the audit
 * found 12 live seeds with zero payoffs. The push-out is a window UPDATE now.
 * `auto_resolve` is the judged-payoff settle — the same lifecycle end as
 * `resolve`, recorded under its own provenance so a payoff the batched
 * adjudicator found is never mistaken for a payoff the Director chose.
 */
// auto_resolve is NOT here by design: it is the adjudicator's verdict, applied
// by id through autoResolveSeed — a model-emitted op must never wear the
// adjudicator's provenance (stack audit, 2026-08-01).
export const SEED_OPS = ["plant", "resolve", "abandon", "adjust_window"] as const;

export const DirectorSeedOp = z.object({
  op: z.enum(SEED_OPS),
  /** plant: the new seed's description. */
  description: z.string().optional(),
  expected_payoff: z.string().optional(),
  payoff_window_from: z.number().int().optional(),
  payoff_window_to: z.number().int().optional(),
  /** plant: descriptions of seeds gating this one (matched to ids engine-side). */
  dependencies: z.array(z.string()).default([]),
  /** resolve/abandon/adjust_window/auto_resolve: match against the existing seed's description. */
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
 *
 * NO LENGTH OR RANGE BOUNDS HERE (M3, after the 2026-08-01 live diagnosis).
 * The same grammar that enforces types STRIPS `minItems`/`maxItems`/
 * `minimum`/`maximum` — they are validated client-side only. A `.max(5)` on
 * director_notes could therefore never stop the model from writing six; it
 * could only fail the parse, burn callStructured's one corrective retry, and
 * throw away the ENTIRE cycle — arc plan, seed ops, demotions and all — over a
 * surplus advisory note. The ceilings are real and they stay: they are stated
 * in the dossier's task list (the model's actual constraint) and applied by
 * `clampDirectorOutput` in direction/director.ts before anything is written.
 *
 * CORRECTION (M3R4 R-1, measured against the installed SDK): the line that used
 * to stand here — "Enums (`ArcShape`, `PacerPhase`, op kinds) and `.int()` ARE
 * grammar-native" — is only half true. `.int()` survives (it becomes
 * `type: "integer"`), but `transformJSONSchema` demotes every `enum` to
 * `type: "string"` with the vocabulary folded into the DESCRIPTION, so enum
 * vocabulary is advice at EVERY level, exactly like the bounds above. The enums
 * here still stand: the dossier spells them in the schema's own case and
 * `clampDirectorOutput` guards the writes. The two that actually leaked — the
 * seed verdict and the Pacer's phase — are lean strings with engine-side
 * normalizers.
 */
export const DirectorOutput = z.object({
  /** Investigation digest — internal, never player-facing (axiom 2). */
  analysis: z.string(),
  /** 0..1; clamped engine-side (the range is not grammar-enforced). */
  tension_level: z.number(),
  // No top-level phase field: arc_plan.phase is the single phase authority —
  // a second unconstrained copy let the Pacer and the arc row diverge (C7 audit).
  arc_plan: DirectorArcPlan,
  /** Delimit a story movement: closes an episode row under the active arc. */
  episode_close: z
    .object({ name: z.string().min(1), dramatic_question: z.string().min(1) })
    .optional(),
  arc_override: z
    .object({
      arc_name: z.string().min(1),
      transition_signal: z.string().min(1),
      /** ≤6 DNA axis shifts, e.g. {axis:"darkness", value:8} (0-10). Invalid axes drop engine-side. */
      dna_shifts: z.array(z.object({ axis: z.string(), value: z.number() })),
      /** ≤4 framing enum shifts, e.g. {axis:"arc_shape", value:"falling"}. */
      composition_shifts: z.array(z.object({ axis: z.string(), value: z.string() })),
    })
    .optional(),
  clear_override: z.boolean(),
  /**
   * §7.1 season-boundary ratification (M3 C4). Emitted ONLY when the dossier
   * carried an EVOLUTION REVIEW section; a proposal raised without that gate is
   * dropped engine-side with a warn (the gate is code, not the model's mood —
   * §7.1's "never an anxious check-in"). The model supplies the destination
   * value only; `from` is read off the active contract, never taken on trust.
   */
  evolution_proposal: z
    .object({
      /** One paragraph, the fiction's own language — shown to the player VERBATIM. */
      director_case: z.string(),
      axes: z.array(z.object({ axis: z.string(), to: z.number() })),
    })
    .optional(),
  scene_shape_trajectory: z.string().optional(),
  /** ≤3. */
  scene_shape_notes: z.array(z.string()),
  /** ≤6 axes, relevance 1-9. */
  arc_relevance: z.array(z.object({ axis: z.string(), relevance: z.number() })),
  /** ≤6. */
  seed_ops: z.array(DirectorSeedOp),
  /** ≤3. */
  spotlight_directives: z.array(z.object({ name: z.string(), note: z.string() })),
  /** Dailies (§6.3 size review): ≤5 critical facts to demote, matched on content. */
  demote_criticals: z.array(z.string()),
  /** ≤5. */
  director_notes: z.array(z.string()),
  /** ≤5. */
  voice_patterns: z.array(z.string()),
});
export type DirectorOutput = z.infer<typeof DirectorOutput>;

// ---------------------------------------------------------------------------
// The two-half EMIT schemas (M3R2 C1). The grammar cliff is MODEL-DEPENDENT:
// Haiku compiles the full DirectorOutput; Sonnet 5 rejects it with 400 "the
// compiled grammar is too large" — which is why every DEV-tier test passed
// while the live Sonnet-judgment campaign burned 37 doomed cycle calls
// ($1.71) writing nothing. Hand-probed 2026-08-03: either half alone
// compiles on Haiku, Sonnet AND Opus; the whole does not on Sonnet. So the
// cycle's final emit is TWO structured calls (plan with the tool loop, then
// ops against the re-sent dossier + the plan's JSON), merged engine-side
// into the unchanged DirectorOutput shape — downstream code never sees the
// split. The seed op drops ALL optionals via required sentinels ('' / 0),
// the same C7 doctrine that keeps always-emitted arrays required;
// mergeDirectorEmits() normalizes sentinels back to undefined, and
// clampDirectorOutput drops blank-required objects the lean grammar can no
// longer refuse. The schema-grammar canary re-proves both halves at Sonnet
// and Opus (the compilers that matter — Haiku is the permissive floor) on
// every paid eval run.
// ---------------------------------------------------------------------------

const DirectorEmitSeedOp = z.object({
  op: z.enum(SEED_OPS),
  /** '' when not applicable (sentinel — the grammar carries no optionals). */
  description: z.string(),
  expected_payoff: z.string(),
  /** 0 when not applicable. */
  payoff_window_from: z.number().int(),
  payoff_window_to: z.number().int(),
  dependencies: z.array(z.string()),
  seed_description: z.string(),
  reason: z.string(),
});

export const DirectorEmitPlan = z.object({
  analysis: z.string(),
  tension_level: z.number(),
  arc_plan: DirectorArcPlan,
  episode_close: z.object({ name: z.string(), dramatic_question: z.string() }).optional(),
  arc_override: z
    .object({
      arc_name: z.string(),
      transition_signal: z.string(),
      dna_shifts: z.array(z.object({ axis: z.string(), value: z.number() })),
      composition_shifts: z.array(z.object({ axis: z.string(), value: z.string() })),
    })
    .optional(),
  clear_override: z.boolean(),
  evolution_proposal: z
    .object({
      director_case: z.string(),
      axes: z.array(z.object({ axis: z.string(), to: z.number() })),
    })
    .optional(),
  /** '' = no trajectory note (sentinel). */
  scene_shape_trajectory: z.string(),
  scene_shape_notes: z.array(z.string()),
});
export type DirectorEmitPlan = z.infer<typeof DirectorEmitPlan>;

export const DirectorEmitOps = z.object({
  arc_relevance: z.array(z.object({ axis: z.string(), relevance: z.number() })),
  seed_ops: z.array(DirectorEmitSeedOp),
  spotlight_directives: z.array(z.object({ name: z.string(), note: z.string() })),
  demote_criticals: z.array(z.string()),
  director_notes: z.array(z.string()),
  voice_patterns: z.array(z.string()),
});
export type DirectorEmitOps = z.infer<typeof DirectorEmitOps>;

/** Sentinel → undefined, halves → the one DirectorOutput downstream code reads. */
export function mergeDirectorEmits(plan: DirectorEmitPlan, ops: DirectorEmitOps): DirectorOutput {
  const clean = (s: string) => (s.trim() === "" ? undefined : s);
  return {
    ...plan,
    scene_shape_trajectory: clean(plan.scene_shape_trajectory),
    arc_relevance: ops.arc_relevance,
    seed_ops: ops.seed_ops.map((op) => ({
      op: op.op,
      description: clean(op.description),
      expected_payoff: clean(op.expected_payoff),
      payoff_window_from: op.payoff_window_from === 0 ? undefined : op.payoff_window_from,
      payoff_window_to: op.payoff_window_to === 0 ? undefined : op.payoff_window_to,
      dependencies: op.dependencies,
      seed_description: clean(op.seed_description),
      reason: clean(op.reason),
    })),
    spotlight_directives: ops.spotlight_directives,
    demote_criticals: ops.demote_criticals,
    director_notes: ops.director_notes,
    voice_patterns: ops.voice_patterns,
  };
}

/**
 * The DirectorOutput emission ceilings, in one place — the schema can no
 * longer carry them (see the contract note above), so the dossier states them
 * and `clampDirectorOutput` applies them.
 */
export const DIRECTOR_CAPS = {
  scene_shape_notes: 3,
  arc_relevance: 6,
  seed_ops: 6,
  spotlight_directives: 3,
  demote_criticals: 5,
  director_notes: 5,
  voice_patterns: 5,
  dna_shifts: 6,
  composition_shifts: 4,
  cold_open_constraints: 5,
  /** A retooling the player can read in one breath — not a re-run of Session Zero. */
  evolution_axes: 4,
} as const;

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
  /**
   * Engine-facing: recorded as an arc event for the Director; never applied.
   *
   * Lean by design (M3R4 R-1), same law as the seed verdict: the vocabulary is
   * description text rather than grammar, and the Pacer's system prompt names
   * phases only in running prose ("Force transition to rising", "STALL GATE").
   * Turn 50 of the N=50 soak died here on an out-of-vocabulary phase, taking
   * the whole beat with it — a suggestion the Director is free to ignore cost
   * the scene its continuity channel. `normalizePhase` (turn/pacer.ts) drops
   * anything unrecognized to "no transition suggested".
   */
  phase_transition: z
    .string()
    .optional()
    .describe(`one of: ${PACER_PHASES.join(" | ")} (lowercase); omit when no transition is due`),
});
export type PacerDirective = z.infer<typeof PacerDirective>;
