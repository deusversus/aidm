import { z } from "zod";
import type { ArcOverride } from "./arc";
import { Composition } from "./composition";
import { DNAScales } from "./dna";
import { AuthorVoice, IPMechanics, PowerTier, VoiceCard } from "./profile";

/**
 * The Premise Instrument (blueprint §4): five components × four time
 * layers. The premise is the product; these are its coordinates.
 *
 * Components: World (rules/cast/canon — fixed under retelling) · Treatment
 * (24 DNA axes — how any scene is rendered) · Framing (13 enums — what the
 * story IS) · Voice (method-of-telling fingerprints) · Canonicality
 * (relationship to the source text).
 *
 * Layers (§4.2): canonical_ (research output) · active_ (player's choices
 * for THIS campaign) · arc_override (Director's transient partial, at most
 * one) · learned (pencil marks — shade the Renderer, never mutate values).
 */

// ---------------------------------------------------------------------------
// Canonicality (§4.1) — enums carried verbatim from v3 canonicality.py
// ---------------------------------------------------------------------------

/** Same timeline / alternate history / original story in the world's clothes. */
export const TimelineMode = z.enum(["canon_adjacent", "alternate", "inspired"]);
export type TimelineMode = z.infer<typeof TimelineMode>;

export const CanonCastMode = z.enum(["full_cast", "replaced_protagonist", "npcs_only"]);
export type CanonCastMode = z.infer<typeof CanonCastMode>;

export const EventFidelity = z.enum(["observable", "influenceable", "background"]);
export type EventFidelity = z.infer<typeof EventFidelity>;

/**
 * Canonicality directives are hard core (axiom 3): the KA is commanded by
 * them, not advised. P3's substrate — divergence is deliberate and
 * trackable, never accidental.
 */
export const Canonicality = z.object({
  timeline_mode: TimelineMode,
  canon_cast_mode: CanonCastMode,
  event_fidelity: EventFidelity,
  /** Divergences from source the player has explicitly blessed. */
  accepted_divergences: z.array(z.string()).default([]),
  /** Contradictions of source canon the engine must never narrate. */
  forbidden_contradictions: z.array(z.string()).default([]),
});

export type Canonicality = z.infer<typeof Canonicality>;

// ---------------------------------------------------------------------------
// Voice (§4.1) — method-of-telling, IP-specific
// ---------------------------------------------------------------------------

/**
 * Cast depth posture (§4.1, playtester-ratified): flanderization is a
 * premise variable, not a universal defect. Prose pressure per cast tier —
 * e.g. "broad-and-deep" vs "role-filling"; Death March's next companion
 * does not need Spike Spiegel's depth, and pretending otherwise is its own
 * infidelity. The Sakkan and dailies calibrate against this, distinguishing
 * sharpening (convergence on a strong identity — desirable) from hollowing
 * (loss of declared depth — drift).
 */
export const CastDepthPosture = z.object({
  main_cast: z.string().min(1),
  supporting: z.string().min(1),
  recurring_bits: z.string().min(1),
});
export type CastDepthPosture = z.infer<typeof CastDepthPosture>;

export const VoiceFingerprint = z.object({
  author_voice: AuthorVoice,
  voice_cards: z.array(VoiceCard).default([]),
  /**
   * 3-5 sentence IP-specific directing voice. Standing test (§4.6): every
   * sentence should be something that could NOT apply to a different anime.
   */
  director_personality: z.string().min(1),
  cast_depth_posture: CastDepthPosture,
});

export type VoiceFingerprint = z.infer<typeof VoiceFingerprint>;

// ---------------------------------------------------------------------------
// The five components, assembled
// ---------------------------------------------------------------------------

/**
 * World = the typed record half of §4.1's World component. Two contents
 * live elsewhere by design: the searchable canon corpus lives in the Canon
 * memory layer, and the cast roster lives in the Entity layer (§6.5),
 * seeded by the Opening State Package's cast briefs — this object carries
 * the rules substrate only. Voice material (author_voice, voice_cards) is
 * omitted because the Voice component is its sole authority (§4.1): in a
 * hybrid, world and voice come from different sources and must not carry
 * diverging copies.
 */
export const WorldComponent = IPMechanics.omit({ author_voice: true, voice_cards: true });
export type WorldComponent = z.infer<typeof WorldComponent>;

export const PremiseComponents = z.object({
  world: WorldComponent,
  treatment: DNAScales,
  framing: Composition,
  voice: VoiceFingerprint,
  canonicality: Canonicality,
});

export type PremiseComponents = z.infer<typeof PremiseComponents>;

/**
 * Effective premise (§4.2): { ...active, ...arc_override }, shaded by
 * learned at RENDER time — pencil marks never mutate values, so they don't
 * appear here. Only Treatment and Framing are overridable; World, Voice,
 * and Canonicality are stable within a campaign (edits to those are premise
 * events, not overrides).
 */
export function effectivePremise(
  active: PremiseComponents,
  override?: ArcOverride | null,
): PremiseComponents {
  if (!override) return active;
  return {
    ...active,
    treatment: { ...active.treatment, ...override.dna },
    framing: { ...active.framing, ...override.composition },
  };
}

// ---------------------------------------------------------------------------
// Hybrids (§4.1) — per-component selection, not an average
// ---------------------------------------------------------------------------

export const HybridComponentSource = z.object({
  /**
   * single = one source supplies the component wholesale; blended = numeric
   * blend (Treatment only — one operation among compositional ones);
   * synthesized = written fresh from the collision (Voice, typically);
   * union = corpora merged with source tags (World/canon for hybrids).
   */
  method: z.enum(["single", "blended", "synthesized", "union"]),
  source_profile_ids: z.array(z.string()).min(1),
  notes: z.string().optional(),
});

export const HybridRecipe = z.object({
  world: HybridComponentSource,
  treatment: HybridComponentSource,
  framing: HybridComponentSource,
  voice: HybridComponentSource,
  canonicality: HybridComponentSource,
  /** Franchise-level merges declare a primary continuity (§4.1). */
  primary_continuity: z.string().optional(),
});

export type HybridRecipe = z.infer<typeof HybridRecipe>;

// ---------------------------------------------------------------------------
// Session Zero sacrosanct records (§7.5, §8) — Critical-layer residents
// ---------------------------------------------------------------------------

/**
 * The finitude question (§8, Series contract): does this story end?
 * finite = the Director quietly builds toward a planned finale across
 * seasons; indefinite = open cycle, the engine never forces an ending;
 * undecided = revisited at season boundaries, never unilaterally resolved.
 * Only the player can change the recorded choice.
 */
export const Finitude = z.enum(["finite", "indefinite", "undecided"]);
export type Finitude = z.infer<typeof Finitude>;

/**
 * The control key (§7.5): loss of control is a stake placed on the table
 * only by the player, at SZ, as a composition choice — berserker modes,
 * corruption, the seal cracking. Bounded: declared circumstances, brief;
 * /meta re-opens the dialectic, /override melts it instantly. Absolute
 * agency remains the inviolable default; no key exists unless the player
 * cuts it.
 */
export const ControlKey = z.object({
  circumstances: z.string().min(1),
  notes: z.string().optional(),
});
export type ControlKey = z.infer<typeof ControlKey>;

/**
 * The intensity contract (§7.5, SZ-gathered, sacrosanct): consent lives at
 * the premise level, not the per-scene level. Within the consented
 * contract, blindsiding is a directorial choice.
 */
export const IntensityContract = z.object({
  /** The world's death physics: Berserk kills; DBZ's death is a doorway; Konosuba's is a punchline. */
  death_physics: z.string().min(1),
  /** The Saturday-night-DM warning: "this campaign is a little more intense." */
  lethality_posture: z.string().min(1),
  /** Things off the table, honored absolutely — no dice. */
  hard_lines: z.array(z.string()).default([]),
  control_key: ControlKey.optional(),
});

export type IntensityContract = z.infer<typeof IntensityContract>;

// ---------------------------------------------------------------------------
// Presentation vocabulary (§8) — expressive formatting as authorial judgment
// ---------------------------------------------------------------------------

/**
 * SZ derives a per-premise presentation vocabulary — diegetic System
 * windows for Solo Leveling (canon World furniture), HUD/comm-chatter for
 * cyberpunk, bare prose for Berserk — granted to the KA in the Settei and
 * used at its judgment. The product layer renders whatever comes; it never
 * imposes. Recap and yokoku posture are authorial choices under the same
 * vocabulary (§9.3, §9.4); the stinger is part of it where the premise
 * supports one.
 */
export const PresentationVocabulary = z.object({
  /** Formatting grants, e.g. "diegetic System status windows (hooks into stat_mapping)".
   *  The one LIVE channel: compiler-populated, rides Block 1 to the KA, and
   *  the recap/yokoku composers judge posture through it (§9.3 "no settings
   *  toggle" — posture is premise-rendered, not a stored enum). */
  grants: z.array(z.string()).default([]),
  /** RESERVED for M3 display grammar (M2R R4 audit: unpopulated, unread).
   *  Recap posture today is delivered as premise judgment via grants. */
  recap_posture: z.string().optional(),
  /** RESERVED for M3 display grammar — yokoku posture rides grants today. */
  yokoku_posture: z.string().optional(),
  /** RESERVED — the stinger (§8) has no mechanism yet; staging decision
   *  lives in M3-display-grammar's open questions. */
  stinger_allowed: z.boolean().default(false),
  /** RESERVED for M3 display grammar — chip skinning deferred (M3-DG plan). */
  suggestion_chip_skin: z.string().optional(),
});

export type PresentationVocabulary = z.infer<typeof PresentationVocabulary>;

/** §9.2: whether chips appear by default is an SZ calibration; "never" is honored. */
export const SuggestionAffordance = z.enum(["default_on", "on_request_only", "never"]);
export type SuggestionAffordance = z.infer<typeof SuggestionAffordance>;

// ---------------------------------------------------------------------------
// The Premise Contract (§8 handoff)
// ---------------------------------------------------------------------------

export const PremiseContract = z.object({
  campaign_id: z.string().min(1),
  canonical: PremiseComponents,
  active: PremiseComponents,
  hybrid_recipe: HybridRecipe.optional(),
  /**
   * The spark (§8): the player's answer to "tell me a scene you want more
   * of — not a plot, a moment," stored VERBATIM. Read by the Renderer
   * (standing Settei note), the Director (arc planning + dailies), and
   * seeded as the campaign's first pencil mark. For hybrids, often the
   * collision of two moments — the campaign's central question.
   */
  spark: z.string().min(1),
  presentation_vocabulary: PresentationVocabulary,
  finitude: Finitude,
  intensity: IntensityContract,
  suggestion_affordance: SuggestionAffordance,
  /**
   * §8/SV3: the player's chosen starting power tier, gathered at the SZ
   * power-tier beat against the world's baseline. Absent = the world's
   * typical tier (pre-SV3 campaigns, or the player waved it off). Layout
   * reads this to drive the §5.1 OP-mode machinery; a future character
   * sheet owns LIVE progression — this is the starting contract.
   */
  pc_power_tier: PowerTier.optional(),
  /** Anchor shows used during SZ calibration (§4.6). */
  anchors_used: z.array(z.string()).default([]),
});

export type PremiseContract = z.infer<typeof PremiseContract>;
