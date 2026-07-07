import { z } from "zod";
import { ProvenanceEnvelope } from "./provenance";

/**
 * The Opening State Package (blueprint §8, v3's full discipline carried):
 * everything Session Zero hands the Director and the first conte —
 * provenance-tagged, confidence-scored, uncertainty stated rather than
 * papered over. The §8 list, verbatim: provenance, confidence, hard/soft
 * constraint tiers, uncertainties with safe assumptions and
 * degraded-generation guidance, Director inputs, Animation inputs incl.
 * forbidden opening moves, cast/world/faction/thread briefs, orphan facts.
 */

export const ConstraintTier = z.enum(["hard", "soft"]);

export const OpeningConstraint = z
  .object({
    text: z.string().min(1),
    tier: ConstraintTier,
  })
  .extend(ProvenanceEnvelope.shape);

/** An unknown the conductor could not settle — stated, never improvised over. */
export const OpeningUncertainty = z.object({
  question: z.string().min(1),
  /** What the engine may assume until play resolves it. */
  safe_assumption: z.string().min(1),
  /** How to write AROUND the unknown without foreclosing it (§8). */
  degraded_generation_guidance: z.string().min(1),
});

export const OpeningBrief = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["cast", "world", "faction", "thread"]),
    brief: z.string().min(1),
    /** Cast briefs: catalog admission happens at compile (§6.5 explicit act). */
    admit_to_catalog: z.boolean().default(false),
  })
  .extend(ProvenanceEnvelope.shape);

export const OpeningStatePackage = z.object({
  /** Where the story opens and why — the Director's pilot planning input. */
  director_inputs: z.object({
    opening_situation: z.string().min(1),
    /** The spark restated as directable pressure. */
    spark_reading: z.string().min(1),
    suggested_first_arc_question: z.string().min(1),
  }),
  /** The KA's pilot constraints. */
  animation_inputs: z.object({
    /** Moves the cold open must NOT make (§8 — forbidden opening moves). */
    forbidden_opening_moves: z.array(z.string()).default([]),
    opening_pov: z.string().min(1),
  }),
  constraints: z.array(OpeningConstraint).default([]),
  uncertainties: z.array(OpeningUncertainty).default([]),
  briefs: z.array(OpeningBrief).default([]),
  /** Facts that fit no brief — kept with provenance, never dropped (§8). */
  orphan_facts: z.array(z.string().min(1)).default([]),
});

export type OpeningStatePackage = z.infer<typeof OpeningStatePackage>;
export type OpeningBrief = z.infer<typeof OpeningBrief>;
export type OpeningConstraint = z.infer<typeof OpeningConstraint>;
