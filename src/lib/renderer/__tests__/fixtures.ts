import type { DNAScales } from "@/lib/types/dna";
import type { PremiseContract } from "@/lib/types/premise";

/** The Bebop golden profile's canonical DNA (evals/golden/profiles/cowboy_bebop.yaml). */
export const BEBOP_DNA: DNAScales = {
  pacing: 6,
  continuity: 3,
  density: 4,
  temporal_structure: 4,
  optimism: 3,
  darkness: 7,
  comedy: 4,
  emotional_register: 6,
  intimacy: 6,
  fidelity: 7,
  reflexivity: 3,
  avant_garde: 6,
  epistemics: 6,
  moral_complexity: 8,
  didacticism: 3,
  cruelty: 5,
  power_treatment: 6,
  scope: 5,
  agency: 6,
  interiority: 6,
  conflict_style: 5,
  register: 7,
  empathy: 8,
  accessibility: 6,
};

export function bebopContract(overrides: Partial<PremiseContract> = {}): PremiseContract {
  const components = {
    world: {
      power_system: {
        name: "mundane combat",
        mechanics: "Physical prowess, firearms, hand-to-hand.",
        limitations: "Real-world physics. Bullets kill. Competent, not superhuman.",
        tiers: [],
      },
      power_distribution: {
        peak_tier: "T9" as const,
        typical_tier: "T9" as const,
        floor_tier: "T10" as const,
        gradient: "compressed" as const,
      },
      stat_mapping: {
        has_canonical_stats: false,
        confidence: 0,
        aliases: {},
        meta_resources: {},
        hidden: [],
        display_order: [],
      },
      combat_style: "narrative" as const,
      storytelling_tropes: {
        tournament_arc: false,
        training_montage: false,
        power_of_friendship: false,
        mentor_death: false,
        chosen_one: false,
        tragic_backstory: true,
        redemption_arc: false,
        betrayal: true,
        sacrifice: true,
        transformation: false,
        forbidden_technique: false,
        time_loop: false,
        false_identity: true,
        ensemble_focus: true,
        slow_burn_romance: true,
      },
      world_setting: {
        genre: ["space western", "neo-noir"],
        locations: ["the Bebop", "Mars", "Ganymede"],
        factions: ["Red Dragon Syndicate", "ISSP"],
        time_period: "2071",
      },
      visual_style: {
        art_style: "90s cel",
        color_palette: "smoke and neon",
        reference_descriptors: [],
      },
    },
    treatment: BEBOP_DNA,
    framing: {
      tension_source: "existential" as const,
      power_expression: "balanced" as const,
      narrative_focus: "ensemble" as const,
      mode: "standard" as const,
      antagonist_origin: "interpersonal" as const,
      antagonist_multiplicity: "episodic" as const,
      arc_shape: "fragmented" as const,
      resolution_trajectory: "tragedy" as const,
      escalation_pattern: "stable" as const,
      status_quo_stability: "gradual" as const,
      player_role: "ensemble_member" as const,
      choice_weight: "local" as const,
      story_time_density: "months" as const,
    },
    voice: {
      author_voice: {
        sentence_patterns: ["clipped, jazz-phrased"],
        structural_motifs: ["cold open", "smash cut to quiet"],
        dialogue_quirks: ["deflection as intimacy"],
        emotional_rhythm: ["long cool, sudden ache"],
        example_voice: "Whatever happens, happens.",
      },
      voice_cards: [],
      director_personality:
        "A jazz musician directing a noir film: improvises, digresses, and always lands the final note a beat after you expect it.",
      cast_depth_posture: {
        main_cast: "broad-and-deep — every regular carries an unspoken history",
        supporting: "sharp silhouettes with one true note",
        recurring_bits: "role-filling; the bit IS the character",
      },
    },
    canonicality: {
      timeline_mode: "canon_adjacent" as const,
      canon_cast_mode: "full_cast" as const,
      event_fidelity: "influenceable" as const,
      accepted_divergences: [],
      forbidden_contradictions: ["Spike's past with the Syndicate is not rewritten"],
    },
  };
  return {
    campaign_id: "fixture_bebop",
    // Cloned twice: canonical/active must never alias each other or the
    // module-level BEBOP_DNA (the eval runner mutates active in-process).
    canonical: structuredClone(components),
    active: structuredClone(components),
    spark: "The moment someone says 'Whatever happens, happens' and walks toward the thing anyway.",
    presentation_vocabulary: { grants: ["bare prose"], stinger_allowed: false },
    finitude: "finite",
    intensity: {
      death_physics: "death is real, sudden, and cheap — nobody gets a speech",
      lethality_posture: "trends toward an end; losses stay lost",
      hard_lines: [],
    },
    suggestion_affordance: "on_request_only",
    anchors_used: [],
    ...overrides,
  };
}
