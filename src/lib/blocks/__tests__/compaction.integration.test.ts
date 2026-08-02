import { notTombstoned } from "@/lib/db/helpers";
import * as schema from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assembleBlocks, block3Text } from "../assemble";
import {
  COMPACT_BEATS_MAX,
  compactionWatermark,
  judgmentCompactor,
  loadBeats,
  runCompaction,
  workingWindow,
} from "../compaction";

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});
const mockJudgment = vi.mocked(callJudgment);

const SELECTION = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
} as const;

const EXCHANGES = [
  { turnNumber: 1, playerInput: "in", narration: "out" },
  { turnNumber: 2, playerInput: "in", narration: "out" },
];

describe("judgmentCompactor emission ceiling (§6.2)", () => {
  it("clamps an over-count compactor instead of throwing the event (2026-08-01)", async () => {
    // The grammar strips maxItems, so `.max(4)` could never hold the compactor
    // to four beats — only fail the parse and throw the compaction event. At
    // 100-turn scale that is the window that never truncates.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockJudgment.mockResolvedValue({
      beats: ["a", "b", "  ", "c", "d", "e", "f"],
    } as never);

    const beats = await judgmentCompactor(SELECTION, { campaignId: "c1", turnNumber: 20 })(
      EXCHANGES,
    );

    expect(beats).toHaveLength(COMPACT_BEATS_MAX);
    expect(beats).toEqual(["a", "b", "c", "d"]); // blanks dropped, then sliced
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("states the ceiling in the prompt — the only place it can now be enforced", async () => {
    mockJudgment.mockResolvedValue({ beats: ["one"] } as never);
    await judgmentCompactor(SELECTION, { campaignId: "c1", turnNumber: 20 })(EXCHANGES);
    const system = String((mockJudgment.mock.calls.at(-1)?.[1] as { system?: string })?.system);
    expect(system).toContain(`at most ${COMPACT_BEATS_MAX} beats`);
  });
});

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

    expect(block3Text(after.system).startsWith(block3Text(before.system))).toBe(true);
    expect(after.system[1]?.text).toBe(before.system[1]?.text);
    // Block-list form (M2R5 C3): the append adds exactly one block and leaves
    // every prior one byte-identical — the moving tail's whole premise.
    expect(after.system).toHaveLength(before.system.length + 1);
    for (const [i, block] of before.system.entries()) {
      expect(after.system[i]?.text).toBe(block.text);
    }
  });

  it("a compactor that produced nothing leaves the window intact (no watermark drift)", async () => {
    if (!db) throw new Error("unreachable");
    // With the schema's min(1) gone, an empty beat list is representable. It
    // must NOT advance the watermark: the window derives from the beats, so a
    // zero-row "success" would drop the stretch out of the writer's memory.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watermarkBefore = await compactionWatermark(db, campaignId);
    const windowBefore = await workingWindow(db, campaignId);

    const report = await runCompaction(db, campaignId, 20, {
      compactor: async () => [],
      keepTail: 1,
    });

    expect(report.compacted).toBe(false);
    expect(report.beatsWritten).toBe(0);
    expect(await compactionWatermark(db, campaignId)).toBe(watermarkBefore);
    expect(await workingWindow(db, campaignId)).toHaveLength(windowBefore.length);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
