import { z } from "zod";

/**
 * Composition — the narrative framing of the story being told.
 *
 * 13 categorical axes. Answers: whose story, what opposition, what arc shape,
 * what resolution, what stakes dynamic. Distinct from DNA (tonal treatment)
 * and IP mechanics (world rules).
 *
 * Enums, not scales — values are discrete story archetypes that don't
 * meaningfully interpolate. "triumph" is not partway between "tragedy"
 * and "ambiguous"; it's a qualitatively different choice.
 *
 * Two-layer usage:
 *   profile.canonical_composition  — source show's default narrative framing
 *   campaign.active_composition    — what the player/conductor chose
 * Arc overrides can shift any axis transiently (see ArcOverride).
 */

// v3-inherited (expanded values preserved verbatim)
export const TensionSource = z.enum([
  "existential", // victory assumed; focus on meaning/aftermath
  "relational", // emotional stakes (bonds, trust, belonging)
  "moral", // ethical dilemmas (right vs. wrong)
  "burden", // power has a cost (sacrifice, corruption, exhaustion)
  "information", // discovery, mystery, learning
  "consequence", // actions ripple (politics, reputation, faction)
  "control", // inner struggle (berserker, corruption, restraint)
]);

export const PowerExpression = z.enum([
  "instantaneous", // one action ends it; focus on reaction
  "overwhelming", // victory inevitable; horror of slow, unstoppable power
  "sealed", // power held back; seal cracks create tension
  "hidden", // secret power; dramatic irony
  "conditional", // power tied to trigger; build toward activation
  "derivative", // power through others (subordinates, armies)
  "passive", // presence alone changes things (aura)
  "flashy", // standard anime combat (stylish, exciting)
  "balanced", // standard pacing
]);

export const NarrativeFocus = z.enum([
  "internal", // protagonist's inner journey
  "ensemble", // team spotlight; allies grow
  "reverse_ensemble", // POV of those facing protagonist
  "episodic", // new cast each arc; legend accumulates
  "faction", // organization management
  "mundane", // ordinary is the goal
  "competition", // hierarchy among powerful
  "legacy", // mentoring next generation
  "party", // balanced adventure party
]);

export const CompositionMode = z.enum([
  "standard", // protagonist at typical tier — straightforward stakes
  "blended", // protagonist above typical — acknowledge power, don't dominate
  "op_dominant", // protagonist far above — reframe stakes onto meaning/relationships
  "not_applicable", // slice-of-life, mystery, anything where power framing doesn't apply
]);

// --- New axes (v4 additions) ---

export const AntagonistOrigin = z.enum([
  "internal", // self, doubt, corruption
  "interpersonal", // specific rival, single villain, small circle
  "societal", // system, institution, culture
  "cosmic", // gods, forces of nature, reality itself
  "environmental", // place/setting as pressure — Made in Abyss, survival shows
]);

export const AntagonistMultiplicity = z.enum([
  "single_recurring", // one primary antagonist across the arc (Death Note)
  "shifting", // antagonist changes as story progresses (Vinland Saga)
  "episodic", // antagonist-of-the-week (Cowboy Bebop)
  "absent", // no explicit antagonist (slice-of-life)
]);

export const ArcShape = z.enum([
  "rising", // escalating action toward climax (most shonen)
  "falling", // decline from a high point (noir, tragedy)
  "cyclical", // returns to status quo (sitcom, procedurals)
  "plateau", // steady exploration without escalation (Mushishi)
  "fragmented", // non-traditional, episodic-with-throughline (Bebop)
]);

export const ResolutionTrajectory = z.enum([
  "triumph", // clear win for protagonist
  "tragedy", // clear loss or cost
  "pyrrhic", // win at catastrophic cost — Berserk Golden Age, Vinland Saga bk 1
  "ambiguous", // readers decide
  "ongoing", // no resolution in this arc; continuation expected
]);

export const EscalationPattern = z.enum([
  "linear", // steady incremental stakes (Haikyuu)
  "exponential", // each arc multiplies (Dragon Ball)
  "waves", // intense peaks with troughs (Attack on Titan)
  "stable", // stakes constant throughout (slice-of-life, Mushishi)
]);

export const StatusQuoStability = z.enum([
  "reset", // world resets each episode (Simpsons)
  "gradual", // world changes slowly across arcs (most anime)
  "transformative", // world fundamentally alters (Death Note, Attack on Titan)
]);

export const PlayerRole = z.enum([
  "protagonist", // the central figure
  "ensemble_member", // one of a team
  "outsider", // witness, journalist, visitor
  "antagonist", // opposing the canonical protagonist
  "observer", // non-participant — slice-of-life in someone else's story
]);

export const ChoiceWeight = z.enum([
  "world_shaping", // consequences ripple to factions, locations, future arcs
  "local", // consequences affect immediate scene / relationships
  "flavor", // choices color narration but don't change outcomes
]);

export const StoryTimeDensity = z.enum([
  "incident", // story compressed into hours/days (one heist, one battle)
  "days", // single week or short span
  "months", // seasonal arc
  "years", // epic timeline with timeskips
]);

export const Composition = z.object({
  // v3-inherited
  tension_source: TensionSource,
  power_expression: PowerExpression,
  narrative_focus: NarrativeFocus,
  mode: CompositionMode,
  // v4 additions
  antagonist_origin: AntagonistOrigin,
  antagonist_multiplicity: AntagonistMultiplicity,
  arc_shape: ArcShape,
  resolution_trajectory: ResolutionTrajectory,
  escalation_pattern: EscalationPattern,
  status_quo_stability: StatusQuoStability,
  player_role: PlayerRole,
  choice_weight: ChoiceWeight,
  story_time_density: StoryTimeDensity,
});

export type Composition = z.infer<typeof Composition>;

export const PartialComposition = Composition.partial();
export type PartialComposition = z.infer<typeof PartialComposition>;
