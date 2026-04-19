import { z } from "zod";

/**
 * DNA scales — the tonal treatment of the story being told.
 *
 * 24 orthogonal axes each scored 0-10. Describes HOW a narrative is told,
 * not the source IP it's told in. A Pokemon campaign told with Berserk's
 * DNA is a legitimate, coherent configuration — the IP supplies the world,
 * the DNA supplies the tone.
 *
 * Two-layer usage:
 *   profile.canonical_dna  — the source show's natural tonal fingerprint
 *   campaign.active_dna    — what the player chose for THIS campaign
 * Delta between the two tells the Director how far from source we've drifted.
 *
 * Organized into 7 groups for readability. All share the same shape: 0-10.
 */

const axis = () => z.number().min(0).max(10);

export const DNAScales = z.object({
  // --- Tempo / structure ---
  /** slow dwell (0) ↔ rapid cuts (10). Controls sentence rhythm and scene length. */
  pacing: axis(),
  /** standalone episodes (0) ↔ serialized arc (10). How much each turn commits to the long thread. */
  continuity: axis(),
  /** single clear thread (0) ↔ many layered threads (10). How much the narrative juggles per scene. */
  density: axis(),
  /** linear (0) ↔ non-linear (10). Are flashbacks, loops, parallel timelines on the table? */
  temporal_structure: axis(),

  // --- Emotional valence ---
  /** cynical (0) ↔ hopeful (10). Thematic valence — does the world reward effort? */
  optimism: axis(),
  /** light (0) ↔ grimdark (10). Distinct from optimism — Made in Abyss is optimistic AND dark. */
  darkness: axis(),
  /** deadly serious (0) ↔ pure comedy (10). Register and fourth-wall permission. */
  comedy: axis(),
  /** understated (0) ↔ overwrought (10). Mushishi restrains; Clannad dwells. */
  emotional_register: axis(),
  /** distant (0) ↔ close (10). Camera warmth — Evangelion has interiority without intimacy. */
  intimacy: axis(),

  // --- Realism / formal ---
  /** grounded realism (0) ↔ absurd stylization (10). How much stylization is permitted. */
  fidelity: axis(),
  /** straight (0) ↔ meta-aware (10). Can characters reference genre? Can narration break fourth wall? */
  reflexivity: axis(),
  /** traditional (0) ↔ experimental (10). FLCL, Lain, Paranoia Agent-level structural invention. */
  avant_garde: axis(),

  // --- Moral / epistemic ---
  /** all explained (0) ↔ mysterious (10). Information asymmetry between story and reader. */
  epistemics: axis(),
  /** black-and-white (0) ↔ morally gray (10). How complicated can the ethics be? */
  moral_complexity: axis(),
  /** ambiguous (0) ↔ didactic (10). Does the work resolve meaning or resist interpretation? */
  didacticism: axis(),
  /** kind to characters (0) ↔ cruel (10). Madoka is optimistic-coded AND extremely cruel. */
  cruelty: axis(),

  // --- Power / stakes ---
  /** celebrate wins (0) ↔ dwell on cost (10). How the narrative THEMATICALLY treats power. */
  power_treatment: axis(),
  /** intimate (0) ↔ cosmic (10). Stakes scale — Mushishi single-village vs. Gurren Lagann universe. */
  scope: axis(),
  /** fatalist (0) ↔ agency-driven (10). Do characters drive events, or are they subject to them? */
  agency: axis(),

  // --- Focus / style ---
  /** external action (0) ↔ internal monologue (10). Narrator's distance from the POV character's head. */
  interiority: axis(),
  /** instinctive (0) ↔ tactical (10). Decision-making style — applies to social battles too, not just combat. */
  conflict_style: axis(),
  /** vernacular (0) ↔ elevated (10). Low vs. high register prose. */
  register: axis(),

  // --- Reader relationship ---
  /** narrow (0) ↔ wide empathic range (10). Do we sympathize with one POV or many? */
  empathy: axis(),
  /** demanding (0) ↔ casual (10). How much hand-holding — One Piece is dense but accessible. */
  accessibility: axis(),
});

export type DNAScales = z.infer<typeof DNAScales>;

/**
 * Partial for arc overrides — Director writes only the axes they want to shift
 * for the current arc. Everything else falls through to active_dna.
 */
export const PartialDNAScales = DNAScales.partial();
export type PartialDNAScales = z.infer<typeof PartialDNAScales>;

/**
 * Compute per-axis delta between two DNA fingerprints. Positive = second is higher
 * on that axis. Useful for Director to reason about "how far from source" a run is.
 */
export function dnaDelta(base: DNAScales, other: DNAScales): Record<keyof DNAScales, number> {
  const keys = Object.keys(base) as Array<keyof DNAScales>;
  return Object.fromEntries(keys.map((k) => [k, other[k] - base[k]])) as Record<
    keyof DNAScales,
    number
  >;
}
