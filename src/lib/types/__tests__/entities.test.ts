import { describe, expect, it } from "vitest";
import {
  ArcPlanHistoryEntry,
  DirectorNote,
  Faction,
  ForeshadowingSeed,
  Location,
  Npc,
  RelationshipEvent,
  SemanticMemory,
  SpotlightDebt,
  VoicePattern,
} from "../entities";

/**
 * Shape tests for Chronicler entity Zod types. Exercises the defaults
 * + constraints so a future schema tightening (e.g., narrowing
 * `milestoneType` to an enum) trips a test rather than silently
 * breaking production writes.
 *
 * DB-level round-trip (insert → select → parse) is covered by the
 * Chronicler-tools tests at Commit 7.2 where write paths land.
 */

// Valid v4-format UUIDs for fixtures (Zod v4 enforces the UUID grammar:
// version nibble [1-8], variant nibble [89abAB]).
const UUID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-9222-222222222222";

describe("Npc", () => {
  it("parses a minimal row with defaults applied", () => {
    const parsed = Npc.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      name: "Faye Valentine",
      firstSeenTurn: 1,
      lastSeenTurn: 1,
    });
    expect(parsed.role).toBe("acquaintance");
    expect(parsed.personality).toBe("");
    expect(parsed.goals).toEqual([]);
    expect(parsed.secrets).toEqual([]);
    expect(parsed.visualTags).toEqual([]);
    expect(parsed.knowledgeTopics).toEqual({});
    expect(parsed.powerTier).toBe("T10");
    expect(parsed.faction).toBeNull();
  });

  it("accepts rich NPC details", () => {
    const parsed = Npc.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      name: "Vicious",
      role: "enemy",
      personality: "cold, violent, absolute",
      goals: ["kill Spike", "lead Red Dragon"],
      secrets: ["Julia backs channel"],
      faction: "Red Dragon Syndicate",
      visualTags: ["silver hair", "katana", "black suit"],
      knowledgeTopics: { red_dragon_politics: "expert", bounty_hunter_world: "moderate" },
      powerTier: "T5",
      ensembleArchetype: "rival",
      firstSeenTurn: 3,
      lastSeenTurn: 42,
    });
    expect(parsed.role).toBe("enemy");
    expect(parsed.knowledgeTopics.red_dragon_politics).toBe("expert");
  });

  it("rejects empty name", () => {
    expect(() =>
      Npc.parse({
        id: UUID,
        campaignId: CAMPAIGN,
        name: "",
        firstSeenTurn: 1,
        lastSeenTurn: 1,
      }),
    ).toThrow();
  });
});

describe("Location + Faction (shape parity)", () => {
  it("Location parses with default details", () => {
    const loc = Location.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      name: "The Bebop",
      firstSeenTurn: 1,
      lastSeenTurn: 1,
    });
    expect(loc.details).toEqual({});
  });
  it("Faction parses with default details", () => {
    const f = Faction.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      name: "Red Dragon Syndicate",
    });
    expect(f.details).toEqual({});
  });
});

describe("RelationshipEvent", () => {
  it("requires milestoneType + evidence as non-empty", () => {
    expect(() =>
      RelationshipEvent.parse({
        id: UUID,
        campaignId: CAMPAIGN,
        npcId: UUID,
        milestoneType: "",
        evidence: "anything",
        turnNumber: 1,
      }),
    ).toThrow();
  });

  it("accepts a well-formed event", () => {
    const ev = RelationshipEvent.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      npcId: UUID,
      milestoneType: "first_vulnerability",
      evidence: "Jet let Spike see the photo of his ex.",
      turnNumber: 12,
    });
    expect(ev.milestoneType).toBe("first_vulnerability");
  });
});

describe("SemanticMemory", () => {
  it("clamps heat to [0, 100]", () => {
    expect(() =>
      SemanticMemory.parse({
        id: UUID,
        campaignId: CAMPAIGN,
        category: "relationship",
        content: "Spike owes Jet gas money.",
        heat: 150,
        turnNumber: 8,
      }),
    ).toThrow();
  });

  it("defaults embedding to null (M4 populates)", () => {
    const m = SemanticMemory.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      category: "relationship",
      content: "Spike owes Jet gas money.",
      heat: 70,
      turnNumber: 8,
    });
    expect(m.embedding).toBeNull();
  });
});

describe("ForeshadowingSeed", () => {
  it("defaults status to PLANTED", () => {
    const s = ForeshadowingSeed.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      name: "Faye's mystery tape",
      description: "A Beta tape from Faye's past she hasn't watched yet.",
      payoffWindowMin: 5,
      payoffWindowMax: 20,
      plantedTurn: 2,
    });
    expect(s.status).toBe("PLANTED");
    expect(s.dependsOn).toEqual([]);
    expect(s.conflictsWith).toEqual([]);
    expect(s.resolvedTurn).toBeNull();
  });

  it("rejects invalid status values", () => {
    expect(() =>
      ForeshadowingSeed.parse({
        id: UUID,
        campaignId: CAMPAIGN,
        name: "x",
        description: "x",
        status: "NONSENSE",
        payoffWindowMin: 1,
        payoffWindowMax: 5,
        plantedTurn: 1,
      }),
    ).toThrow();
  });
});

describe("VoicePattern + DirectorNote + SpotlightDebt", () => {
  it("VoicePattern defaults evidence to empty string", () => {
    const vp = VoicePattern.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      pattern: "terse openings",
      turnObserved: 5,
    });
    expect(vp.evidence).toBe("");
  });

  it("DirectorNote defaults scope to session", () => {
    const n = DirectorNote.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      content: "Keep Faye in the frame this session.",
      createdAtTurn: 3,
    });
    expect(n.scope).toBe("session");
  });

  it("SpotlightDebt allows negative debt (underexposed)", () => {
    const d = SpotlightDebt.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      npcId: UUID,
      debt: -3,
      updatedAtTurn: 10,
    });
    expect(d.debt).toBe(-3);
  });
});

describe("ArcPlanHistoryEntry", () => {
  it("requires valid phase + mode enums", () => {
    expect(() =>
      ArcPlanHistoryEntry.parse({
        id: UUID,
        campaignId: CAMPAIGN,
        currentArc: "x",
        arcPhase: "nonsense",
        arcMode: "main_arc",
        tensionLevel: 0.5,
        setAtTurn: 1,
      }),
    ).toThrow();
  });

  it("parses a well-formed entry", () => {
    const e = ArcPlanHistoryEntry.parse({
      id: UUID,
      campaignId: CAMPAIGN,
      currentArc: "Syndicate closing in",
      arcPhase: "complication",
      arcMode: "main_arc",
      plannedBeats: ["Faye picks up a lead", "Jet warns Spike"],
      tensionLevel: 0.7,
      setAtTurn: 15,
    });
    expect(e.arcPhase).toBe("complication");
    expect(e.plannedBeats).toHaveLength(2);
  });
});
