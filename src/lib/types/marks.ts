import { z } from "zod";
import { ProvenanceEnvelope } from "./provenance";

/**
 * Pencil marks — the Learned layer's typed calibration records (blueprint
 * §6.6). Accumulated from play and meta feedback; they SHADE the Renderer
 * (rendered into the Settei or Amendments as advisory craft prose) and
 * never mutate player-set active premise values.
 *
 * Writers — enumerated strong signals only (§6.6): meta-booth resolutions;
 * explicit player meta-comments caught by the Phase-A probe; N=3
 * consecutive Sakkan drift reports on the same axis; session-close voice
 * journal + director memo.
 *
 * Supersession: a new mark on the same (kind, topic) marks priors
 * superseded — kept for provenance, excluded from rendering. "Never decays"
 * means never lost, not never demoted; contradictory calibration resolves
 * to latest-wins.
 */

export const PencilMarkKind = z.enum(["axis", "voice_feature", "craft_note"]);
export type PencilMarkKind = z.infer<typeof PencilMarkKind>;

export const PencilMark = z
  .object({
    id: z.string().min(1),
    kind: PencilMarkKind,
    /**
     * The specific thing calibrated: a DNA axis name for `axis`, a Voice
     * fingerprint feature for `voice_feature`, a short slug for
     * `craft_note`. Supersession matches on (kind, topic).
     */
    topic: z.string().min(1),
    /** The calibration itself, as craft prose: "less flowery", "hold the falling beat longer". */
    direction: z.string().min(1),
    /** Quote or source that earned the mark. */
    evidence: z.string().min(1),
    superseded_by: z.string().optional(),
  })
  .extend(ProvenanceEnvelope.shape);

export type PencilMark = z.infer<typeof PencilMark>;

/** Marks still eligible for rendering: not superseded. */
export function activeMarks(marks: PencilMark[]): PencilMark[] {
  return marks.filter((m) => m.superseded_by === undefined);
}
