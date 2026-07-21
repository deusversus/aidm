import { describe, expect, it } from "vitest";
import type { ArcOverride } from "../arc";
import type { Composition } from "../composition";
import { type DNAScales, dnaDelta } from "../dna";
import { PencilMark, activeMarks } from "../marks";
import {
  type PremiseComponents,
  PremiseContract,
  PresentationVocabulary,
  effectivePremise,
} from "../premise";
import type { IPMechanics } from "../profile";

function treatment(overrides: Partial<DNAScales> = {}): DNAScales {
  const base: DNAScales = {
    pacing: 4,
    continuity: 3,
    density: 5,
    temporal_structure: 4,
    optimism: 3,
    darkness: 6,
    comedy: 4,
    emotional_register: 3,
    intimacy: 6,
    fidelity: 3,
    reflexivity: 2,
    avant_garde: 4,
    epistemics: 6,
    moral_complexity: 7,
    didacticism: 2,
    cruelty: 5,
    power_treatment: 6,
    scope: 3,
    agency: 4,
    interiority: 5,
    conflict_style: 6,
    register: 5,
    empathy: 6,
    accessibility: 6,
  };
  return { ...base, ...overrides };
}

function framing(overrides: Partial<Composition> = {}): Composition {
  const base: Composition = {
    tension_source: "existential",
    power_expression: "balanced",
    narrative_focus: "ensemble",
    mode: "standard",
    antagonist_origin: "interpersonal",
    antagonist_multiplicity: "episodic",
    arc_shape: "fragmented",
    resolution_trajectory: "ambiguous",
    escalation_pattern: "waves",
    status_quo_stability: "gradual",
    player_role: "ensemble_member",
    choice_weight: "local",
    story_time_density: "months",
  };
  return { ...base, ...overrides };
}

function world(): IPMechanics {
  return {
    power_distribution: {
      peak_tier: "T7",
      typical_tier: "T9",
      floor_tier: "T10",
      gradient: "compressed",
    },
    stat_mapping: {
      has_canonical_stats: false,
      confidence: 90,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    },
    combat_style: "tactical",
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
      slow_burn_romance: false,
    },
    world_setting: {
      genre: ["space western", "noir"],
      locations: ["the Bebop", "Mars", "Ganymede"],
      factions: ["The Syndicate", "ISSP"],
      time_period: "2071",
    },
    voice_cards: [],
    author_voice: {
      sentence_patterns: ["clipped, jazz-phrased"],
      structural_motifs: ["cold open", "smash cut to quiet"],
      dialogue_quirks: ["deflection as intimacy"],
      emotional_rhythm: ["long cool, sudden ache"],
      example_voice: "Whatever happens, happens.",
    },
    visual_style: {
      art_style: "90s cel",
      color_palette: "smoke and neon",
      reference_descriptors: [],
    },
  };
}

function components(): PremiseComponents {
  return {
    world: world(),
    treatment: treatment(),
    framing: framing(),
    voice: {
      author_voice: world().author_voice,
      voice_cards: [],
      director_personality:
        "Ends every bounty in a draw that costs more than the reward. Lets silence do the grieving the cast refuses to do out loud.",
      cast_depth_posture: {
        main_cast: "broad-and-deep — every regular carries an unspoken history",
        supporting: "sharp silhouettes with one true note",
        recurring_bits: "role-filling; the bit IS the character",
      },
    },
    canonicality: {
      timeline_mode: "canon_adjacent",
      canon_cast_mode: "full_cast",
      event_fidelity: "influenceable",
      accepted_divergences: [],
      forbidden_contradictions: ["Spike's past with the Syndicate is not rewritten"],
    },
  };
}

describe("PremiseContract", () => {
  it("round-trips a full contract through parse", () => {
    const contract = {
      campaign_id: "camp_1",
      canonical: components(),
      active: components(),
      spark: "The moment Spike says 'Whatever happens, happens' and walks toward the thing anyway.",
      presentation_vocabulary: {
        grants: ["bare prose; episode-title cards only"],
        directives: [{ name: "readout", skin: "the bounty terminal" }],
        recap_posture: "barely bothers — one wry line",
        stinger_allowed: false,
      },
      finitude: "finite",
      intensity: {
        death_physics: "death is real, sudden, and cheap — nobody gets a speech",
        lethality_posture: "this one trends toward an end; losses stay lost",
        hard_lines: [],
      },
      suggestion_affordance: "on_request_only",
    };
    const parsed = PremiseContract.parse(contract);
    expect(parsed.spark).toBe(contract.spark);
    expect(parsed.anchors_used).toEqual([]);
    expect(parsed.intensity.control_key).toBeUndefined();
    expect(parsed.presentation_vocabulary.stinger_allowed).toBe(false);
    // M3-DG: structured directives round-trip; the skin defaults to "" if unset.
    expect(parsed.presentation_vocabulary.directives).toEqual([
      { name: "readout", skin: "the bounty terminal" },
    ]);
  });

  it("presentation_vocabulary.directives defaults to [] and skins default to '' (M3-DG)", () => {
    const vocab = PresentationVocabulary.parse({ grants: [] });
    expect(vocab.directives).toEqual([]);
    const skinless = PresentationVocabulary.parse({ directives: [{ name: "memory" }] });
    expect(skinless.directives).toEqual([{ name: "memory", skin: "" }]);
  });

  it("rejects a contract without a spark", () => {
    const contract = {
      campaign_id: "camp_1",
      canonical: components(),
      active: components(),
      spark: "",
      presentation_vocabulary: {},
      finitude: "undecided",
      intensity: { death_physics: "x", lethality_posture: "y" },
      suggestion_affordance: "never",
    };
    expect(() => PremiseContract.parse(contract)).toThrow();
  });
});

describe("effectivePremise", () => {
  const override: ArcOverride = {
    arc_name: "The Syndicate Closes In",
    started_turn: 41,
    transition_signal: "Spike walks out of the church",
    dna: { darkness: 9, comedy: 1 },
    composition: { antagonist_multiplicity: "single_recurring" },
  };

  it("override axes win; untouched axes fall through to active", () => {
    const active = components();
    const eff = effectivePremise(active, override);
    expect(eff.treatment.darkness).toBe(9);
    expect(eff.treatment.comedy).toBe(1);
    expect(eff.treatment.pacing).toBe(active.treatment.pacing);
    expect(eff.framing.antagonist_multiplicity).toBe("single_recurring");
    expect(eff.framing.arc_shape).toBe(active.framing.arc_shape);
  });

  it("no override → active returned unchanged", () => {
    const active = components();
    expect(effectivePremise(active)).toEqual(active);
    expect(effectivePremise(active, null)).toEqual(active);
  });

  it("does not mutate active", () => {
    const active = components();
    const before = active.treatment.darkness;
    effectivePremise(active, override);
    expect(active.treatment.darkness).toBe(before);
  });
});

describe("dnaDelta", () => {
  it("computes signed per-axis drift", () => {
    const a = treatment();
    const b = treatment({ darkness: 9, comedy: 1 });
    const delta = dnaDelta(a, b);
    expect(delta.darkness).toBe(3);
    expect(delta.comedy).toBe(-3);
    expect(delta.pacing).toBe(0);
  });
});

describe("PencilMark", () => {
  it("round-trips and filters superseded marks", () => {
    const mark = PencilMark.parse({
      id: "mark_1",
      kind: "axis",
      topic: "emotional_register",
      direction: "less flowery — hold the restraint even in payoffs",
      evidence: 'player, turn 12: "less flowery please"',
      turn_id: 12,
      provenance: "meta_booth",
      confidence: 0.9,
    });
    const superseded = { ...mark, id: "mark_0", superseded_by: "mark_1" };
    expect(activeMarks([mark, superseded])).toEqual([mark]);
  });
});
