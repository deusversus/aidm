import * as schema from "@/lib/db/schema";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type OpeningType,
  allPairsSimilar,
  classifyOpening,
  composeVocabAdvisory,
  findRepeatedNgrams,
  measureRepetition,
  modalOpeningType,
  pickBreakDirective,
} from "../antirep";
import { STYLE_DRIFT_POOL } from "../diversity";

/**
 * Anti-repetition suite (§5.3). Pure detectors are unit-tested directly;
 * `measureRepetition` runs against real dev Postgres for the episodic reads
 * with Voyage mocked (basis vectors control the clustering verdict), mirroring
 * the layout.integration harness.
 */

vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});
const mockEmbed = vi.mocked(embedTexts);

// ── Pure detectors ───────────────────────────────────────────────────────────

describe("classifyOpening", () => {
  it("reads a leading quote or em-dash as dialogue", () => {
    expect(classifyOpening('"Get up," Jet said, hauling the crate.')).toBe("dialogue");
    expect(classifyOpening("—Down! Spike hit the deck.")).toBe("dialogue");
  });

  it("reads a cognition/emotion verb as interiority", () => {
    expect(classifyOpening("Spike knew it was a trap the moment the door opened.")).toBe(
      "interiority",
    );
    expect(classifyOpening("Faye felt the old ache return.")).toBe("interiority");
  });

  it("reads weather/time vocabulary or a spatial lead as scenery", () => {
    expect(classifyOpening("Rain hammered the derelict's rusted hull.")).toBe("scenery");
    expect(classifyOpening("Outside, the city held its breath.")).toBe("scenery");
  });

  it("falls through to action for a plain subject+verb open", () => {
    expect(classifyOpening("Spike drew his pistol and kicked the hatch open.")).toBe("action");
  });

  it("does not misread a trailing place mention as scenery", () => {
    // "alley" lands past the lookahead window — this is an action open.
    expect(classifyOpening("Spike sprinted the length of the narrow alley.")).toBe("action");
  });
});

describe("modalOpeningType", () => {
  it("returns the type shared by >=2 of three scenes", () => {
    expect(modalOpeningType(["dialogue", "dialogue", "action"])).toBe("dialogue");
    expect(modalOpeningType(["action", "action", "action"])).toBe("action");
  });

  it("returns null when all three differ (variety)", () => {
    expect(modalOpeningType(["dialogue", "action", "scenery"])).toBeNull();
  });
});

describe("pickBreakDirective", () => {
  it("is deterministic in (type, campaignId, counter)", () => {
    const a = pickBreakDirective("dialogue", "camp-1", 5);
    const b = pickBreakDirective("dialogue", "camp-1", 5);
    expect(a).toBe(b);
  });

  it("names a concrete craft move from the shuffle bag", () => {
    const d = pickBreakDirective("dialogue", "camp-1", 5);
    expect(STYLE_DRIFT_POOL.some((m) => d.includes(m))).toBe(true);
  });

  it("never reinforces the measured pattern", () => {
    // Every rotation for a dialogue repeat must avoid 'open with dialogue'.
    for (let counter = 0; counter < 20; counter++) {
      const d = pickBreakDirective("dialogue", "camp-1", counter);
      expect(d.includes("open with dialogue")).toBe(false);
    }
  });

  it("does not repeat the directive on consecutive counters", () => {
    for (const type of ["dialogue", "action", "scenery", "interiority"] as OpeningType[]) {
      for (let counter = 0; counter < 20; counter++) {
        expect(pickBreakDirective(type, "camp-1", counter)).not.toBe(
          pickBreakDirective(type, "camp-1", counter + 1),
        );
      }
    }
  });
});

describe("allPairsSimilar", () => {
  it("true when every pair clears the threshold", () => {
    expect(
      allPairsSimilar(
        [
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
        ],
        0.82,
      ),
    ).toBe(true);
  });

  it("false when a pair is orthogonal", () => {
    expect(
      allPairsSimilar(
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        0.82,
      ),
    ).toBe(false);
  });

  it("false with fewer than two vectors", () => {
    expect(allPairsSimilar([[1, 0, 0]], 0.82)).toBe(false);
  });
});

describe("findRepeatedNgrams", () => {
  it("names a content phrase repeated across >=2 narrations", () => {
    const phrases = findRepeatedNgrams(
      [
        "The rain kept falling over the ruined city.",
        "By dusk the rain kept falling harder than before.",
        "Nothing moved in the corridor.",
      ],
      { jargonWhitelist: [] },
    );
    expect(phrases).toContain("the rain kept falling");
  });

  it("ignores whitelisted IP jargon but keeps content phrases", () => {
    const phrases = findRepeatedNgrams(
      [
        "He channeled his nen through the blade.",
        "Again he channeled his nen through the rain, and the rain fell over him.",
        "The rain fell over the broken street.",
      ],
      { jargonWhitelist: ["nen"] },
    );
    expect(phrases).toContain("the rain fell over");
    expect(phrases.some((p) => p.includes("nen"))).toBe(false);
  });

  it("ignores 4-grams anchored on a proper noun", () => {
    const phrases = findRepeatedNgrams(
      ["They chased Vicious through the dark.", "Later, they chased Vicious through the alley."],
      { jargonWhitelist: [] },
    );
    expect(phrases.some((p) => p.includes("vicious"))).toBe(false);
  });
});

describe("composeVocabAdvisory", () => {
  it("undefined when nothing fired", () => {
    expect(composeVocabAdvisory(false, [])).toBeUndefined();
  });

  it("names the texture convergence when the cluster is tight", () => {
    expect(composeVocabAdvisory(true, [])).toContain("converging");
  });

  it("quotes the recurring phrases", () => {
    const out = composeVocabAdvisory(false, ["the rain fell over"]);
    expect(out).toContain('"the rain fell over"');
  });
});

// ── measureRepetition against real Postgres ─────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) console.warn("[antirep] DATABASE_URL not set — skipping DB tests");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const ENV = { turnId: 1, provenance: "test_seed", confidence: 0.9 };

async function newCampaign(playerId: string): Promise<string> {
  if (!db) throw new Error("unreachable");
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      playerId,
      title: "antirep fixture",
      status: "active",
      premiseContract: bebopContract(),
    })
    .returning({ id: schema.campaigns.id });
  if (!campaign) throw new Error("campaign insert failed");
  return campaign.id;
}

async function seedEpisodes(
  campaignId: string,
  entries: { turnNumber: number; narration: string }[],
): Promise<void> {
  if (!db) throw new Error("unreachable");
  for (const e of entries) {
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: e.turnNumber,
      playerInput: `input ${e.turnNumber}`,
      narration: e.narration,
      ...ENV,
    });
  }
}

describe.skipIf(!url)("measureRepetition (real Postgres, mocked Voyage)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "antirep@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.playerId, playerId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(() => {
    mockEmbed.mockReset();
  });

  it("fewer than 3 scenes → no readings, zero Voyage calls", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await newCampaign(playerId);
    await seedEpisodes(campaignId, [
      { turnNumber: 1, narration: '"Hello," she said.' },
      { turnNumber: 2, narration: "Spike drew his gun." },
    ]);
    const readings = await measureRepetition(db, campaignId, { jargonWhitelist: [] });
    expect(readings).toEqual({});
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("three dialogue opens → styleDriftDirective naming a craft move", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const campaignId = await newCampaign(playerId);
    await seedEpisodes(campaignId, [
      { turnNumber: 1, narration: '"Move it," Jet barked at the crew.' },
      { turnNumber: 2, narration: '"You again," Faye murmured, unimpressed.' },
      { turnNumber: 3, narration: '"Bang," Spike whispered, and pulled the trigger.' },
    ]);
    const readings = await measureRepetition(db, campaignId, { jargonWhitelist: [] });
    expect(readings.styleDriftDirective).toBeDefined();
    expect(STYLE_DRIFT_POOL.some((m) => readings.styleDriftDirective?.includes(m))).toBe(true);
    expect(readings.vocabFreshnessAdvisory).toBeUndefined();
  });

  it("varied opens + orthogonal texture + no repeats → silent", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const campaignId = await newCampaign(playerId);
    await seedEpisodes(campaignId, [
      { turnNumber: 1, narration: '"Coffee?" Jet offered without looking up.' },
      { turnNumber: 2, narration: "Spike vaulted the railing after the bounty." },
      { turnNumber: 3, narration: "Dawn bled across the smog-choked skyline." },
    ]);
    const readings = await measureRepetition(db, campaignId, { jargonWhitelist: [] });
    expect(readings.styleDriftDirective).toBeUndefined();
    expect(readings.vocabFreshnessAdvisory).toBeUndefined();
  });

  it("tight embedding cluster → vocabFreshnessAdvisory names the convergence", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockResolvedValue([
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    const campaignId = await newCampaign(playerId);
    await seedEpisodes(campaignId, [
      { turnNumber: 1, narration: '"Coffee?" Jet offered without looking up.' },
      { turnNumber: 2, narration: "Spike vaulted the railing after the bounty." },
      { turnNumber: 3, narration: "Dawn bled across the smog-choked skyline." },
    ]);
    const readings = await measureRepetition(db, campaignId, { jargonWhitelist: [] });
    expect(readings.styleDriftDirective).toBeUndefined();
    expect(readings.vocabFreshnessAdvisory).toContain("converging");
  });

  it("repeated 4-gram → named in the advisory; whitelisted jargon ignored", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const campaignId = await newCampaign(playerId);
    await seedEpisodes(campaignId, [
      { turnNumber: 1, narration: '"Move," she said, and the rain fell over them.' },
      {
        turnNumber: 2,
        narration: "Vicious channeled his nen through the storm as the rain fell over the deck.",
      },
      {
        turnNumber: 3,
        narration:
          "Spike knew he had channeled his nen through the rain, and the rain fell over everything.",
      },
    ]);
    const readings = await measureRepetition(db, campaignId, { jargonWhitelist: ["nen"] });
    expect(readings.vocabFreshnessAdvisory).toContain("the rain fell over");
    expect(readings.vocabFreshnessAdvisory?.includes("nen")).toBe(false);
    expect(readings.styleDriftDirective).toBeUndefined();
  });
});
