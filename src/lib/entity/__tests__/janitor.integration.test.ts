import * as schema from "@/lib/db/schema";
import { callProbe } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewCatalog } from "../janitor";

/**
 * The janitor (§6.5, M2 C1) against real Postgres with a scripted probe and
 * deterministic embeddings. Pins: the live Lloyd-thread pair auto-merges to one
 * row on a high-confidence verdict; a suggest-band pair lands in
 * direction_state.merge_suggestions and does NOT merge (player word owns the
 * ambiguous band).
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[entity/janitor] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const mockProbe = vi.mocked(callProbe);
const mockEmbed = vi.mocked(embedTexts);

function basis(i: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return v;
}

const ENV = { provenance: "sz_compiler", confidence: 1 } as const;

describe.skipIf(!url)("Janitor catalog review (real Postgres, scripted probe)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "janitor@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "Janitor fixture", status: "active" })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockReset();
    mockEmbed.mockReset();
    // Same-type names embed identically → distance 0, always a candidate.
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
    await db.delete(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    await db
      .update(schema.campaigns)
      .set({ directionState: null })
      .where(eq(schema.campaigns.id, campaignId));
  });

  it("auto-merges the live Lloyd-thread pair on a high-confidence verdict", async () => {
    if (!db) throw new Error("unreachable");
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({ same: true, confidence: 0.95, reason: "same forming bond" } as never),
    );
    const [older] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Path-Crossing with Lloyd",
        entityType: "thread",
        block: "The protagonist and Lloyd keep crossing paths.",
        turnId: 1,
        ...ENV,
      })
      .returning();
    const [newer] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Lloyd and the protagonist's connection",
        entityType: "thread",
        block: "A bond is forming between them.",
        turnId: 2,
        ...ENV,
      })
      .returning();
    if (!older || !newer) throw new Error("seed failed");

    const report = await reviewCatalog(db, campaignId, 5, DEV_TIER_SELECTION);

    expect(report.merged).toHaveLength(1);
    expect(report.suggested).toHaveLength(0);
    // Survivor is the OLDER row (lower turnId); the newer tombstones into it.
    expect(report.merged[0]?.survivorId).toBe(older.id);
    expect(report.merged[0]?.dupeId).toBe(newer.id);

    const live = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "thread")),
      );
    const liveIds = live.filter((r) => r.tombstonedAt === null).map((r) => r.id);
    expect(liveIds).toEqual([older.id]);
  });

  it("surfaces a suggest-band pair to direction_state without merging", async () => {
    if (!db) throw new Error("unreachable");
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({
        same: true,
        confidence: 0.7,
        reason: "possibly the same smuggler",
      } as never),
    );
    const [a] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Kaz",
        entityType: "npc",
        block: "A smuggler.",
        turnId: 1,
        ...ENV,
      })
      .returning();
    const [b] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Kazuki",
        entityType: "npc",
        block: "A smuggler with a debt.",
        turnId: 2,
        ...ENV,
      })
      .returning();
    if (!a || !b) throw new Error("seed failed");

    const report = await reviewCatalog(db, campaignId, 5, DEV_TIER_SELECTION);

    expect(report.merged).toHaveLength(0);
    expect(report.suggested).toHaveLength(1);
    expect(report.suggested[0]?.confidence).toBe(0.7);
    expect(report.suggested[0]?.entity_type).toBe("npc");
    expect(report.suggested[0]?.at_turn).toBe(5);

    // Neither row tombstoned — the ambiguous band never auto-takes.
    const live = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "npc")),
      );
    expect(live.filter((r) => r.tombstonedAt === null)).toHaveLength(2);

    // Persisted to direction_state.merge_suggestions.
    const [row] = await db
      .select({ directionState: schema.campaigns.directionState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const suggestions = (row?.directionState as { merge_suggestions?: unknown[] })
      ?.merge_suggestions;
    expect(suggestions).toHaveLength(1);
  });
});
