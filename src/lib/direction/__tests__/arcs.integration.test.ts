import * as schema from "@/lib/db/schema";
import { seasonBoundary, seasonPosition } from "@/lib/direction/arcs";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Season stratum's DB-denominated arithmetic (§7.3) and the §7.1 boundary
 * signal the evolution gate rides on (M3 C4). No model calls — pure layer reads.
 *
 * The trap this suite exists for: episodes hang off ARC rows, and arcs hang off
 * the season, so a season's episode count is a GRANDCHILD count. arcPosition's
 * direct-child query reads zero for a season row and would report every season
 * as untouched forever — a boundary that never arrives.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn("[arcs] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const envelope = { turnId: 0, provenance: "director", confidence: 0.9 };

describe.skipIf(!url)("season strata (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "season fixture",
        status: "active",
        premiseContract: bebopContract(),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  /** A season with `target` episodes of budget and `episodes` closed under one arc. */
  async function scaffold(
    campaignId: string,
    opts: { target: number; episodes: number; status?: string },
  ): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [season] = await db
      .insert(schema.arcs)
      .values({
        campaignId,
        name: "Season 1",
        stratum: "season",
        dramaticQuestion: "does the crew outrun its own past?",
        shape: "rising",
        budget: { unit: "episodes", target: opts.target, tolerance: 4 },
        phase: "rising",
        status: opts.status ?? "active",
        ...envelope,
      })
      .returning({ id: schema.arcs.id });
    if (!season) throw new Error("season insert failed");

    const [arc] = await db
      .insert(schema.arcs)
      .values({
        campaignId,
        name: "The Ganymede Bounty",
        stratum: "arc",
        dramaticQuestion: "do they collect?",
        shape: "rising",
        budget: { unit: "episodes", target: 4, tolerance: 1 },
        phase: "rising",
        status: "active",
        parentId: season.id,
        ...envelope,
      })
      .returning({ id: schema.arcs.id });
    if (!arc) throw new Error("arc insert failed");

    for (let i = 0; i < opts.episodes; i++) {
      await db.insert(schema.arcs).values({
        campaignId,
        name: `Episode ${i + 1}`,
        stratum: "episode",
        dramaticQuestion: "q",
        shape: "rising",
        budget: { unit: "scenes", target: 1, tolerance: 0 },
        phase: "resolution",
        status: "closed",
        parentId: arc.id,
        ...envelope,
      });
    }
    return season.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "season@example.com" });
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

  it("seasonPosition counts closed episodes through the arcs beneath it", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const seasonId = await scaffold(campaignId, { target: 12, episodes: 5 });
    const [season] = await db.select().from(schema.arcs).where(eq(schema.arcs.id, seasonId));
    if (!season) throw new Error("unreachable");

    const position = await seasonPosition(db, campaignId, season, 40);
    expect(position).toMatchObject({ consumed: 5, target: 12 });
    expect(position.fraction).toBeCloseTo(5 / 12);
  });

  it("mid-season is not a boundary — the gate stays shut through ordinary play", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await scaffold(campaignId, { target: 12, episodes: 5 });
    expect(await seasonBoundary(db, campaignId, 40)).toBeNull();
  });

  it("a spent budget IS the boundary", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await scaffold(campaignId, { target: 4, episodes: 4 });
    expect(await seasonBoundary(db, campaignId, 40)).toMatchObject({
      name: "Season 1",
      consumed: 4,
      target: 4,
      reason: "budget_reached",
    });
  });

  it("a season row that reads closing is a declared boundary whatever its count", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await scaffold(campaignId, { target: 12, episodes: 1, status: "closing" });
    expect(await seasonBoundary(db, campaignId, 40)).toMatchObject({
      reason: "closing",
      consumed: 1,
    });
  });

  it("a campaign with no season scaffold has no boundary (never a crash)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    expect(await seasonBoundary(db, campaignId, 40)).toBeNull();
  });
});
