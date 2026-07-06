import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { CampaignCreationRequest } from "../campaign";
import { Profile } from "../profile";

function loadYaml(filename: string): unknown {
  const p = path.resolve(__dirname, "../../../../evals/golden/profiles", filename);
  return yaml.load(readFileSync(p, "utf-8"));
}

describe("Profile round-trip — Cowboy Bebop", () => {
  const raw = loadYaml("cowboy_bebop.yaml");

  it("parses cleanly against the Profile schema", () => {
    const parsed = Profile.parse(raw);
    expect(parsed.id).toBe("al_1");
    expect(parsed.title).toBe("Cowboy Bebop");
    expect(parsed.media_type).toBe("anime");
  });

  it("carries the full 24-axis canonical DNA", () => {
    const parsed = Profile.parse(raw);
    const keys = Object.keys(parsed.canonical_dna);
    expect(keys).toHaveLength(24);
    expect(parsed.canonical_dna.optimism).toBe(3);
    expect(parsed.canonical_dna.moral_complexity).toBe(8);
    expect(parsed.canonical_dna.empathy).toBe(8);
  });

  it("uses categorical composition values (not numeric)", () => {
    const parsed = Profile.parse(raw);
    expect(parsed.canonical_composition.tension_source).toBe("existential");
    expect(parsed.canonical_composition.resolution_trajectory).toBe("tragedy");
    expect(parsed.canonical_composition.arc_shape).toBe("fragmented");
  });

  it("has no canonical stat mapping (Bebop has no on-screen stats)", () => {
    const parsed = Profile.parse(raw);
    expect(parsed.ip_mechanics.stat_mapping.has_canonical_stats).toBe(false);
    expect(parsed.ip_mechanics.stat_mapping.confidence).toBe(0);
  });
});

describe("Profile round-trip — Solo Leveling (exercises stat mapping)", () => {
  const raw = loadYaml("solo_leveling.yaml");

  it("parses cleanly against the Profile schema", () => {
    const parsed = Profile.parse(raw);
    expect(parsed.id).toBe("al_151807");
    expect(parsed.title).toBe("Solo Leveling");
    expect(parsed.media_type).toBe("manhwa");
  });

  it("carries the Hunter System stat mapping with correct shape", () => {
    const parsed = Profile.parse(raw);
    const sm = parsed.ip_mechanics.stat_mapping;
    expect(sm.has_canonical_stats).toBe(true);
    expect(sm.confidence).toBeGreaterThanOrEqual(90);
    expect(sm.system_name).toBe("Hunter System");
    expect(sm.aliases.STR?.base).toEqual(["STR"]);
    expect(sm.aliases.SENSE?.base).toEqual(["WIS"]);
    expect(sm.aliases.AGI?.method).toBe("direct");
    expect(sm.meta_resources.LUK).toMatch(/reroll/i);
    expect(sm.hidden).toContain("CHA");
  });

  it("reflects op_dominant power mode with exponential escalation", () => {
    const parsed = Profile.parse(raw);
    expect(parsed.canonical_composition.mode).toBe("op_dominant");
    expect(parsed.canonical_composition.escalation_pattern).toBe("exponential");
    expect(parsed.canonical_dna.power_treatment).toBe(9);
  });
});

describe("Profile schema — rejection cases", () => {
  it("rejects a DNA scale outside [0, 10]", () => {
    const raw = loadYaml("cowboy_bebop.yaml") as Record<string, unknown>;
    const mutated = structuredClone(raw);
    (mutated.canonical_dna as Record<string, number>).optimism = 15;
    expect(() => Profile.parse(mutated)).toThrow();
  });

  it("rejects an invalid composition enum value", () => {
    const raw = loadYaml("cowboy_bebop.yaml") as Record<string, unknown>;
    const mutated = structuredClone(raw);
    (mutated.canonical_composition as Record<string, string>).resolution_trajectory = "heroic";
    expect(() => Profile.parse(mutated)).toThrow();
  });

  it("rejects a Profile missing required ip_mechanics", () => {
    const raw = loadYaml("cowboy_bebop.yaml") as Record<string, unknown>;
    const mutated = structuredClone(raw);
    Reflect.deleteProperty(mutated, "ip_mechanics");
    expect(() => Profile.parse(mutated)).toThrow();
  });
});

describe("CampaignCreationRequest — hybrid resolution input", () => {
  it("accepts a single-profile strict campaign", () => {
    const req = CampaignCreationRequest.parse({
      profile_refs: ["al_1"],
      user_intent: "Strict Bebop run as a rookie bounty hunter on the Bebop.",
    });
    expect(req.profile_refs).toEqual(["al_1"]);
  });

  it("accepts a hybrid campaign with partial DNA overrides", () => {
    const req = CampaignCreationRequest.parse({
      profile_refs: ["al_1", "al_151807"],
      user_intent:
        "Bebop's noir pacing with Solo Leveling's Hunter System. Gates open inside the solar system; bounties and raids overlap.",
      dna_overrides: {
        darkness: 8,
        power_treatment: 7,
      },
      composition_overrides: {
        narrative_focus: "party",
      },
    });
    expect(req.profile_refs).toHaveLength(2);
    expect(req.dna_overrides?.darkness).toBe(8);
    expect(req.composition_overrides?.narrative_focus).toBe("party");
  });

  it("rejects a request with zero profile refs", () => {
    expect(() =>
      CampaignCreationRequest.parse({
        profile_refs: [],
        user_intent: "no profiles",
      }),
    ).toThrow();
  });
});
