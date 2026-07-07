import { notTombstoned } from "@/lib/db/helpers";
import * as schema from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleBlocks } from "../assemble";
import { compactionWatermark, loadBeats, runCompaction, workingWindow } from "../compaction";

/** Real-DB proof of the §5.6 discipline: the window only shrinks through a compaction event. */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[compaction.integration] DATABASE_URL not set — skipping real-DB suite");
}

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

describe.skipIf(!url)("compaction event (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "blocks@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "compaction fixture" })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
    await db.insert(schema.episodicRecords).values(
      Array.from({ length: 14 }, (_, i) => ({
        campaignId,
        turnNumber: i + 1,
        playerInput: `input ${i + 1}`,
        narration: `Narration for turn ${i + 1}, long enough to matter.`,
        turnId: i + 1,
        provenance: "integration_test",
        confidence: 1,
      })),
    );
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      if (campaignId) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      }
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("window derives from the watermark; compaction moves exchanges into beats", async () => {
    if (!db) throw new Error("unreachable");
    expect(await compactionWatermark(db, campaignId)).toBe(0);
    const before = await workingWindow(db, campaignId);
    expect(before).toHaveLength(14);

    const report = await runCompaction(db, campaignId, 14, { keepTail: 4 });
    expect(report.compacted).toBe(true);
    expect(report.exchangesCompacted).toBe(10);
    expect(report.beatsWritten).toBe(10);
    expect(report.b3TokensTruncated).toBeGreaterThan(0);

    expect(await compactionWatermark(db, campaignId)).toBe(10);
    const after = await workingWindow(db, campaignId);
    expect(after.map((e) => e.turnNumber)).toEqual([11, 12, 13, 14]);

    const beats = await loadBeats(db, campaignId);
    expect(beats).toHaveLength(10);
    expect(beats[0]?.content).toContain("(t1)");
  });

  it("compaction is the only truncation: re-running with a small window is a no-op", async () => {
    if (!db) throw new Error("unreachable");
    const report = await runCompaction(db, campaignId, 14, { keepTail: 4 });
    expect(report.compacted).toBe(false);
    expect(await workingWindow(db, campaignId)).toHaveLength(4);
  });

  it("assembled B3 prefix stays stable across an append (the cache invariant, DB-backed)", async () => {
    if (!db) throw new Error("unreachable");
    const beats = await loadBeats(db, campaignId);
    const watermark = await compactionWatermark(db, campaignId);
    const windowBefore = await workingWindow(db, campaignId);
    const before = assembleBlocks({
      settei: "# S",
      beats,
      exchanges: windowBefore,
      pins: [],
      watermark,
    });

    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 15,
      playerInput: "input 15",
      narration: "Narration for turn 15.",
      turnId: 15,
      provenance: "integration_test",
      confidence: 1,
    });
    const windowAfter = await workingWindow(db, campaignId);
    const after = assembleBlocks({
      settei: "# S",
      beats,
      exchanges: windowAfter,
      pins: [],
      watermark,
    });

    expect(after.system[2]?.text.startsWith(before.system[2]?.text ?? "!")).toBe(true);
    expect(after.system[1]?.text).toBe(before.system[1]?.text);
  });

  it("beat writes carry the provenance envelope", async () => {
    if (!db) throw new Error("unreachable");
    const rows = await db
      .select()
      .from(schema.compactedBeats)
      .where(
        and(eq(schema.compactedBeats.campaignId, campaignId), notTombstoned(schema.compactedBeats)),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.provenance).toBe("compaction_event");
    expect(rows[0]?.turnId).toBe(14);
  });
});
