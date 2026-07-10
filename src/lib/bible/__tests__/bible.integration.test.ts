import { composeBible } from "@/lib/bible/bible";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import type { PremiseContract } from "@/lib/types/premise";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Series Bible composer (§9.1, C9) against real Postgres. No model calls
 * anywhere — the composition is pure layer reads. Covers the reveal gate, the
 * entityType grouping with dismissed/tombstoned exclusion, the player-minted
 * badge, the world-facts category filter (sz_fact + promoted, minus contract
 * and demoted), and hard lines surfacing from the intensity contract.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn("[bible] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

/** The shared provenance envelope every layer write carries (§6, columns.ts). */
function envelope(turnId: number, provenance: string) {
  return { turnId, provenance, confidence: 1 };
}

describe.skipIf(!url)("composeBible (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(contract: Partial<PremiseContract> = {}): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Bebop, but the crew found the money",
        status: "active",
        premiseContract: bebopContract(contract),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  async function completeTurn(campaignId: string, turnNumber = 1): Promise<void> {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber,
      tier: "genga",
      status: "complete",
      playerInput: "the cold open",
    });
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "bible@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      for (const id of campaignIds) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
      }
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("teases before the cold open — revealed false, layers empty, cast not leaked", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    // Seed content that MUST stay hidden until the first complete turn.
    await db.insert(schema.entities).values({
      campaignId,
      name: "Faye Valentine",
      entityType: "npc",
      block: "A gambler with someone else's memories.",
      ...envelope(0, "sz_handoff"),
    });
    await db.insert(schema.criticalFacts).values({
      campaignId,
      content: "The Bebop is low on fuel.",
      category: "sz_fact",
      ...envelope(0, "sz_handoff"),
    });

    const bible = await composeBible(db, campaignId);
    expect(bible).not.toBeNull();
    expect(bible?.revealed).toBe(false);
    expect(bible?.cast).toEqual([]);
    expect(bible?.factions).toEqual([]);
    expect(bible?.locations).toEqual([]);
    expect(bible?.threads).toEqual([]);
    expect(bible?.worldFacts).toEqual([]);
    // Scalars still compose — the tease surface can show title/spark.
    expect(bible?.spark).toBe(bebopContract().spark);
  });

  it("reveals after one complete turn with premise essentials", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await completeTurn(campaignId);

    const bible = await composeBible(db, campaignId);
    expect(bible?.revealed).toBe(true);
    expect(bible?.premise.finitude).toBe("finite");
    expect(bible?.premise.powerSystem).toBe("mundane combat");
    expect(bible?.premise.worldName).toContain("space western");
    expect(bible?.spark).toContain("Whatever happens, happens");
  });

  it("groups by entityType and excludes dismissed + tombstoned", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await completeTurn(campaignId);
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "Jet Black",
        entityType: "npc",
        block: "Ex-cop, keeps the ship running.",
        ...envelope(1, "chronicler_g2"),
      },
      {
        campaignId,
        name: "Red Dragon Syndicate",
        entityType: "faction",
        block: "The crime family Spike walked out on.",
        ...envelope(1, "chronicler_g2"),
      },
      {
        campaignId,
        name: "The Bebop",
        entityType: "location",
        block: "A fishing trawler turned bounty ship.",
        ...envelope(1, "chronicler_g2"),
      },
      {
        campaignId,
        name: "The bounty on Vicious",
        entityType: "thread",
        block: "Unfinished business, still open.",
        ...envelope(2, "chronicler_g2"),
      },
      {
        campaignId,
        name: "Ein",
        entityType: "npc",
        block: "A data dog — dismissed from the scene.",
        status: "dismissed",
        ...envelope(1, "chronicler_g2"),
      },
      {
        campaignId,
        name: "Ghost NPC",
        entityType: "npc",
        block: "Rewound out of history.",
        tombstonedAt: new Date(),
        ...envelope(1, "chronicler_g2"),
      },
    ]);

    const bible = await composeBible(db, campaignId);
    expect(bible?.cast.map((c) => c.name)).toEqual(["Jet Black"]);
    expect(bible?.factions.map((f) => f.name)).toEqual(["Red Dragon Syndicate"]);
    expect(bible?.locations.map((l) => l.name)).toEqual(["The Bebop"]);
    expect(bible?.threads.map((t) => t.name)).toEqual(["The bounty on Vicious"]);
  });

  it("flags player-minted entities and not chronicler-written ones", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await completeTurn(campaignId);
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "ISSP",
        entityType: "faction",
        block: "The space police.",
        ...envelope(1, "chronicler_g2"),
      },
      {
        campaignId,
        name: "The Anon Syndicate",
        entityType: "faction",
        block: "A rival ring the player invented mid-scene.",
        ...envelope(3, "player_assertion"),
      },
    ]);

    const bible = await composeBible(db, campaignId);
    const byName = Object.fromEntries((bible?.factions ?? []).map((f) => [f.name, f]));
    expect(byName["The Anon Syndicate"]?.playerMinted).toBe(true);
    expect(byName.ISSP?.playerMinted).toBe(false);
  });

  it("world facts include sz_fact + promoted, exclude contract + demoted", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await completeTurn(campaignId);
    await db.insert(schema.criticalFacts).values([
      {
        campaignId,
        content: "Spike left the Syndicate.",
        category: "sz_fact",
        ...envelope(0, "sz_handoff"),
      },
      {
        campaignId,
        content: "Faye owes 300 million woolongs.",
        category: "promoted",
        ...envelope(2, "chronicler_g2"),
      },
      {
        campaignId,
        content: "Finitude: finite.",
        category: "contract",
        ...envelope(0, "sz_handoff"),
      },
      {
        campaignId,
        content: "A stale fact, since demoted.",
        category: "sz_fact",
        demotedAt: new Date(),
        ...envelope(1, "chronicler_g2"),
      },
    ]);

    const bible = await composeBible(db, campaignId);
    const contents = (bible?.worldFacts ?? []).map((f) => f.content);
    expect(contents).toContain("Spike left the Syndicate.");
    expect(contents).toContain("Faye owes 300 million woolongs.");
    expect(contents).not.toContain("Finitude: finite.");
    expect(contents).not.toContain("A stale fact, since demoted.");
    // The sz_handoff fact is not a player assertion → not badged.
    const spikeFact = bible?.worldFacts.find((f) => f.content === "Spike left the Syndicate.");
    expect(spikeFact?.playerMinted).toBe(false);
  });

  it("surfaces hard lines from the intensity contract", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      intensity: {
        death_physics: "death is real, sudden, and cheap",
        lethality_posture: "losses stay lost",
        hard_lines: ["no harm to children on screen", "no sexual violence"],
      },
    });
    await completeTurn(campaignId);

    const bible = await composeBible(db, campaignId);
    expect(bible?.premise.hardLines).toEqual([
      "no harm to children on screen",
      "no sexual violence",
    ]);
  });
});
