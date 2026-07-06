import { z } from "zod";
import { Composition } from "./composition";
import { DNAScales } from "./dna";

/**
 * Profile — canonical descriptive data about a source anime/manga/manhwa.
 * Static for the campaign's lifetime.
 *
 * Four top-level groups:
 *   1. Identification — title, IDs, aliases, series relationships
 *   2. IP mechanics — world rules (power system, stat mapping, cast, tropes,
 *      visual style, power distribution)
 *   3. Canonical tonal/framing — how the source is NATURALLY told
 *      (canonical_dna + canonical_composition). Used as defaults when a
 *      campaign is created; player can diverge from these.
 *   4. Director personality — IP-specific directing voice. Logically part of
 *      group 3 (it shapes tone at session boundaries) but kept as a top-level
 *      field because it's a free-form string, not a structured axis set.
 *
 * Profile schemas match v3's AnimeResearchOutput where IP-mechanics shape
 * is stable (power_system, stat_mapping, voice_cards, visual_style, etc.)
 * and re-architect tonal data into the canonical_dna + canonical_composition
 * two-field form.
 */

export const MediaType = z.enum(["anime", "manga", "manhwa", "donghua", "light_novel"]);
export const MediaStatus = z.enum(["ongoing", "completed", "hiatus"]);
export const RelationType = z.enum(["canonical", "spinoff", "alternate_timeline", "parody"]);
export const CombatStyle = z.enum(["tactical", "spectacle", "comedy", "spirit", "narrative"]);
export const GradientShape = z.enum(["spike", "top_heavy", "flat", "compressed"]);

// T1 = multiversal/omnipotent; T10 = human baseline.
export const PowerTier = z.enum(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]);

/** Power system (name + mechanics + limitations + tiers). Nen, Quirks, Cursed Energy, etc. */
export const PowerSystem = z.object({
  name: z.string(),
  mechanics: z.string(),
  /** The constraints KA MUST respect — costs, triggers, hard rules. */
  limitations: z.string(),
  /** Ordered list of tier names from highest to lowest (or as canon specifies). */
  tiers: z.array(z.string()).default([]),
});

/** Power distribution across the setting. */
export const PowerDistribution = z.object({
  peak_tier: PowerTier,
  typical_tier: PowerTier,
  floor_tier: PowerTier,
  gradient: GradientShape,
});

/** Method for translating a canonical stat into D&D-equivalent internal stat. */
export const StatMethod = z.enum(["direct", "max", "avg", "primary"]);

/** D&D base stat targets used as the internal mechanical substrate. */
export const DndStat = z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]);

/** Canonical stat mapping — bridges on-screen stat systems (Solo Leveling Hunter System, etc.) to D&D internals. */
export const StatMapping = z.object({
  has_canonical_stats: z.boolean(),
  confidence: z.number().min(0).max(100),
  system_name: z.string().optional(),
  aliases: z
    .record(z.string(), z.object({ base: z.array(DndStat), method: StatMethod }))
    .default({}),
  meta_resources: z.record(z.string(), z.string()).default({}),
  hidden: z.array(DndStat).default([]),
  display_order: z.array(z.string()).default([]),
  display_scale: z.object({ multiplier: z.number(), offset: z.number() }).optional(),
});

/** Voice card for a main-cast character. */
export const VoiceCard = z.object({
  name: z.string(),
  speech_patterns: z.string(),
  humor_type: z.enum(["Sardonic", "Earnest", "Deadpan", "Slapstick", "none"]),
  signature_phrases: z.array(z.string()).default([]),
  dialogue_rhythm: z.string(),
  emotional_expression: z.enum(["Restrained", "Explosive", "Deflecting", "Direct"]),
});

/** The source's narrative voice fingerprint. Drives KA's prose style. */
export const AuthorVoice = z.object({
  sentence_patterns: z.array(z.string()).default([]),
  structural_motifs: z.array(z.string()).default([]),
  dialogue_quirks: z.array(z.string()).default([]),
  emotional_rhythm: z.array(z.string()).default([]),
  example_voice: z.string(),
});

export const VisualStyle = z.object({
  art_style: z.string(),
  color_palette: z.string(),
  line_work: z.string().optional(),
  shading: z.string().optional(),
  character_rendering: z.string().optional(),
  atmosphere: z.string().optional(),
  composition_style: z.string().optional(),
  studio_reference: z.string().optional(),
  reference_descriptors: z.array(z.string()).default([]),
});

export const WorldSetting = z.object({
  genre: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  factions: z.array(z.string()).default([]),
  time_period: z.string().optional(),
});

/** 15 boolean trope flags preserved from v3. */
export const StorytellingTropes = z.object({
  tournament_arc: z.boolean(),
  training_montage: z.boolean(),
  power_of_friendship: z.boolean(),
  mentor_death: z.boolean(),
  chosen_one: z.boolean(),
  tragic_backstory: z.boolean(),
  redemption_arc: z.boolean(),
  betrayal: z.boolean(),
  sacrifice: z.boolean(),
  transformation: z.boolean(),
  forbidden_technique: z.boolean(),
  time_loop: z.boolean(),
  false_identity: z.boolean(),
  ensemble_focus: z.boolean(),
  slow_burn_romance: z.boolean(),
});

/** The world/rules substrate — things that stay fixed no matter how the story's told. */
export const IPMechanics = z.object({
  power_system: PowerSystem.optional(),
  power_distribution: PowerDistribution,
  stat_mapping: StatMapping,
  combat_style: CombatStyle,
  storytelling_tropes: StorytellingTropes,
  world_setting: WorldSetting,
  voice_cards: z.array(VoiceCard).default([]),
  author_voice: AuthorVoice,
  visual_style: VisualStyle,
});

export const Profile = z.object({
  // --- Identification ---
  id: z.string().min(1),
  title: z.string().min(1),
  alternate_titles: z.array(z.string()).default([]),
  anilist_id: z.number().int().optional(),
  mal_id: z.number().int().optional(),
  media_type: MediaType,
  status: MediaStatus,
  series_group: z.string().optional(),
  series_position: z.number().int().optional(),
  related_franchise: z.string().optional(),
  relation_type: RelationType.default("canonical"),

  // --- IP mechanics (the world) ---
  ip_mechanics: IPMechanics,

  // --- Canonical tonal / framing ---
  /** The source's natural tonal fingerprint — serves as a default when a campaign is created. */
  canonical_dna: DNAScales,
  /** The source's default narrative framing — serves as a default when a campaign is created. */
  canonical_composition: Composition,

  // --- Director personality ---
  /** 3-5 sentence directing style prompt, IP-specific. Drives Director's voice at session boundaries. */
  director_personality: z.string(),
});

export type Profile = z.infer<typeof Profile>;
