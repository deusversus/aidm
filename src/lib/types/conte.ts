import { z } from "zod";
import { ProvenanceEnvelope } from "./provenance";
import { OutcomeOutput, SakugaMode, TurnTier } from "./turn";

/**
 * The Conte (Scene Brief, blueprint §5.1 §16) — the storyboard handed to
 * key animation: everything the writer sees this turn, assembled by Layout
 * as Block 4 (uncached, dynamic). The field list is §5.1's, exhaustive.
 * List caps are part of the prescription budget (axiom 4): raw retrieval
 * never enters the conte unfiltered.
 */

/** A filtered memory entering the conte, provenance tag attached (§6.4). */
export const ConteMemory = z
  .object({
    content: z.string().min(1),
    /** Which layer supplied it: semantic, episodic, critical, hot_baseline… */
    layer: z.string().min(1),
  })
  .extend(ProvenanceEnvelope.shape);
export type ConteMemory = z.infer<typeof ConteMemory>;

export const CanonChunk = z.object({
  source_profile_id: z.string().min(1),
  page_type: z.string().min(1),
  content: z.string().min(1),
});
export type CanonChunk = z.infer<typeof CanonChunk>;

/**
 * Pre-resolved mechanics (§5.1 hard core): dice and spends resolved in
 * Phase A, before narration — the KA narrates facts, it never rolls.
 * Checkpointed with the conte; a Phase-B retry reuses the same dice
 * (re-rolling on retry feels rigged, §5.7). Thin scaffold; combat depth
 * sharpens at M1.
 */
export const DieRoll = z.object({
  sides: z.number().int().positive(),
  rolled: z.number().int().positive(),
  modifier: z.number().int().default(0),
  total: z.number().int(),
  purpose: z.string().min(1),
});

export const PreResolvedMechanics = z.object({
  rolls: z.array(DieRoll).default([]),
  resource_spends: z
    .array(z.object({ resource: z.string().min(1), amount: z.number() }))
    .default([]),
  combat_results: z.string().optional(),
});
export type PreResolvedMechanics = z.infer<typeof PreResolvedMechanics>;

/**
 * The Pacer's beat-level fields, carried into every conte (§7.2). Strength
 * tri-level: suggestion/strong are advisory; override is hard core and
 * permitted only when a stall-table threshold is met (axiom 3).
 */
export const PacerBeat = z.object({
  beat_classification: z.string().min(1),
  escalation_target: z.string().optional(),
  tone: z.string().optional(),
  must_reference: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  foreshadowing_hint: z.string().optional(),
  /** The Pacer's per-turn drive/breather note (M2R2 — was computed and dropped). */
  pacing_note: z.string().optional(),
  strength: z.enum(["suggestion", "strong", "override"]),
});
export type PacerBeat = z.infer<typeof PacerBeat>;

export const Conte = z.object({
  turn_id: z.number().int().nonnegative(),
  tier: TurnTier,

  /** Douga turns carry a synthetic success at minor weight — still typed. */
  outcome: OutcomeOutput.optional(),
  mechanics: PreResolvedMechanics.optional(),

  /** Settei Amendments (§4.4b): arc_override pressure + Sakkan retakes + fresh pencil marks. ≤250 tokens of prose. */
  charter_amendments: z.string().default(""),
  /** Scene-Shape Directive (§4.4c): Framing's consumer path, ≤150 tokens. */
  scene_shape_directive: z.string().default(""),
  pacer_beat: PacerBeat.optional(),

  /** Hard core (axiom 3). */
  canonicality_directives: z.array(z.string()).default([]),
  hard_constraints: z.array(z.string()).default([]),

  /** Callbacks as opportunities, never obligations (§5.1). */
  callbacks: z.array(z.string()).max(3).default([]),
  memories: z.array(ConteMemory).max(5).default([]),
  canon_chunks: z.array(CanonChunk).max(3).default([]),

  /** Living prose blocks for present catalog cast + transients (§6.5). */
  entity_cards: z.array(z.string()).default([]),
  spotlight_hints: z.array(z.string()).default([]),
  active_consequences: z.array(z.string()).max(8).default([]),
  world_assertion_notes: z.array(z.string()).default([]),

  /** Injected only when measured (§5.3). */
  style_drift_directive: z.string().optional(),
  vocab_freshness_advisory: z.string().optional(),

  sakuga_mode: SakugaMode.optional(),
  /** Phase-A research findings when the probe flagged unknowns. */
  research_findings: z.array(z.string()).default([]),

  /** Degrade ladder fired (§5.5); the Sakkan excludes degraded turns from drift samples. */
  degraded: z.boolean().default(false),
});

export type Conte = z.infer<typeof Conte>;
