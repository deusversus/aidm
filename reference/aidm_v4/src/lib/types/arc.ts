import { z } from "zod";
import { PartialComposition } from "./composition";
import { PartialDNAScales } from "./dna";

/**
 * Arc override — Director's transient deviation from campaign's active state.
 *
 * Lifecycle:
 *   - Director sets `arc_override` on the campaign when a new arc needs a
 *     temporary tonal or framing shift
 *   - KA/Director read effective state as: { ...active_*, ...arc_override?.* }
 *     (partials carry only the axes Director explicitly shifted)
 *   - KA watches the narrative for the `transition_signal` event
 *   - When the signal fires in prose, the override clears; active_* takes
 *     back over without ceremony
 *
 * v3 modeled this implicitly through Director's arc_mode enum (main_arc /
 * ensemble_arc / adversary_ensemble_arc / ...). v4 generalizes to any
 * composition/DNA axis.
 */
export const ArcOverride = z.object({
  arc_name: z.string().min(1),
  started_turn: z.number().int().nonnegative(),
  /** Prose event that will close the override and return to active_* state. */
  transition_signal: z.string().min(1),
  dna: PartialDNAScales.optional(),
  composition: PartialComposition.optional(),
});

export type ArcOverride = z.infer<typeof ArcOverride>;
