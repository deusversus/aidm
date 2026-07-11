import { z } from "zod";
import { DNAScales } from "./dna";

/**
 * Grounding data contracts (blueprint §4.6–4.7): the anchor library pins
 * witness shows to bands per axis; the exemplar library holds the
 * synthesized in-register passages the Renderer and Sakkan stand on.
 * Both live as repo-versioned YAML under rule_library/.
 */

type AxisKey = keyof z.infer<typeof DNAScales>;
export const AXIS_NAMES = Object.keys(DNAScales.shape) as [AxisKey, ...AxisKey[]];
export const AxisName = z.enum(AXIS_NAMES);
export type AxisName = AxisKey;

/** Bands carry the 0–10 scale's calibration points; v0 pins 1/5/9. */
export const Band = z.union([z.literal(1), z.literal(5), z.literal(9)]);
export type Band = z.infer<typeof Band>;

export const AnchorShow = z.object({
  title: z.string().min(1),
  /** Why this show witnesses this band — one line, IP-specific. */
  note: z.string().min(1),
});

export const AnchorBand = z.object({
  shows: z.array(AnchorShow).min(2).max(5),
  /** Exemplar id exemplifying this band (extremes at v0; band 5 gains excerpts with the M2 reliability eval). */
  excerpt_ref: z.string().optional(),
});

export const AnchorFile = z.object({
  axis: AxisName,
  /** The axis's 0↔10 meaning, carried for scoring prompts. */
  scale: z.string().min(1),
  bands: z.object({
    "1": AnchorBand,
    "5": AnchorBand,
    "9": AnchorBand,
  }),
});
export type AnchorFile = z.infer<typeof AnchorFile>;

/**
 * Sourcing rule (§4.7, also the legal posture): synthesized in the
 * register of the anchor show or hand-authored — NEVER verbatim source
 * text. Passages are original material; canon names stay out.
 */
export const Exemplar = z.object({
  id: z.string().min(1),
  axis: AxisName,
  band: Band,
  anchor_show: z.string().min(1),
  author: z.string().min(1),
  method: z.enum(["synthesized", "hand"]),
  /** 80–150 words of in-register prose pressure. */
  text: z.string().min(200),
});
export type Exemplar = z.infer<typeof Exemplar>;

export const ExemplarFile = z.object({
  axis: AxisName,
  exemplars: z.array(Exemplar).min(1),
});
export type ExemplarFile = z.infer<typeof ExemplarFile>;

/** The ten highest-leverage axes — v0 coverage (M0 plan §0.5). Historical record; use COVERED_AXES. */
export const V0_AXES: AxisName[] = [
  "pacing",
  "darkness",
  "comedy",
  "emotional_register",
  "intimacy",
  "interiority",
  "register",
  "cruelty",
  "epistemics",
  "moral_complexity",
];

/**
 * Axes with authored extreme coverage — grew via the grounding-gap rule
 * (M1 plan C1) until M2-C6 completed the build-out: FULL coverage, every
 * axis, both extremes, judge-gated (§4.7, §12). The coverage invariant in
 * grounding.ts now guards all 24; a new axis added to DNAScales without
 * authored grounding fails the loader by construction.
 */
export const COVERED_AXES: AxisName[] = [...AXIS_NAMES];
