import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleBlocks, block3Text } from "../assemble";
import {
  BLOCK2_CEILING_TOKENS,
  type CompactionReport,
  EPOCH_MIN_MERGE_BEATS,
  type EpochCandidate,
  compactionWatermark,
  enforceBlock2Ceiling,
  epochEventCount,
  epochLevelOf,
  judgmentEpochSummarizer,
  loadBeats,
  maybeCompact,
  runEpochMerge,
  selectEpochSpan,
} from "../compaction";
import { approxTokens } from "../tokens";

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

function candidate(position: number, overrides: Partial<EpochCandidate> = {}): EpochCandidate {
  return {
    id: `beat-${String(position).padStart(3, "0")}`,
    position,
    content: `beat at ${position}`,
    fromTurn: position * 5 + 1,
    toTurn: position * 5 + 5,
    turnId: position * 5 + 5,
    isEpoch: false,
    provenance: "chronicler_compaction",
    ...overrides,
  };
}

describe("epoch span selection (§6.2 — the oldest 50%)", () => {
  it("refuses below the two-row floor: one beat has nothing to merge with", () => {
    expect(selectEpochSpan([])).toEqual([]);
    expect(selectEpochSpan([candidate(0)])).toEqual([]);
    expect(EPOCH_MIN_MERGE_BEATS).toBe(2);
  });

  it("takes half, oldest first, by position", () => {
    const ten = Array.from({ length: 10 }, (_, i) => candidate(i));
    expect(selectEpochSpan(ten).map((b) => b.position)).toEqual([0, 1, 2, 3, 4]);
    const twenty = Array.from({ length: 20 }, (_, i) => candidate(i));
    expect(selectEpochSpan(twenty)).toHaveLength(10);
  });

  it("never merges fewer than two — strict progress is what terminates the recursion", () => {
    // floor(n/2) is 1 at n=2 and n=3; a one-row "merge" would replace one row
    // with one row and the ceiling loop would never make progress.
    expect(selectEpochSpan([candidate(0), candidate(1)]).map((b) => b.position)).toEqual([0, 1]);
    expect(selectEpochSpan([candidate(0), candidate(1), candidate(2)])).toHaveLength(2);
    expect(selectEpochSpan(Array.from({ length: 5 }, (_, i) => candidate(i)))).toHaveLength(2);
  });

  it("orders by position regardless of input order (Block-2 bytes are row-determined)", () => {
    const shuffled = [candidate(3), candidate(0), candidate(2), candidate(1)];
    expect(selectEpochSpan(shuffled).map((b) => b.position)).toEqual([0, 1]);
  });
});

describe("epoch level (the hierarchy coordinate, carried in provenance)", () => {
  it("reads the level a merge stamped", () => {
    expect(epochLevelOf({ isEpoch: false, provenance: "chronicler_compaction" })).toBe(0);
    expect(epochLevelOf({ isEpoch: true, provenance: "epoch_merge_l1" })).toBe(1);
    expect(epochLevelOf({ isEpoch: true, provenance: "epoch_merge_l7" })).toBe(7);
  });

  it("floors an epoch with unrecognised provenance at 1, never at 0", () => {
    // Reading an epoch as a plain beat would let a merge stamp a level it has
    // already used — the hierarchy would flatten silently.
    expect(epochLevelOf({ isEpoch: true, provenance: "hand_written" })).toBe(1);
    expect(epochLevelOf({ isEpoch: true, provenance: "epoch_merge_l" })).toBe(1);
  });
});

describe("the ceiling gate (§6.2 — 8k)", () => {
  const base: CompactionReport = {
    compacted: false,
    exchangesCompacted: 0,
    beatsWritten: 0,
    b3TokensTruncated: 0,
    b2TokensAfter: 0,
    epochMergeDue: false,
    epochMerges: 0,
    beatsMerged: 0,
    epochLevel: 0,
  };

  it("does not fire AT the ceiling — and touches neither the db nor a model", async () => {
    // The null db is the assertion: at or under 8k the gate returns before it
    // reads anything. A gate that queried on every G2 would be a per-turn cost
    // for nothing.
    const report = await enforceBlock2Ceiling(null as unknown as Db, "campaign", 42, SELECTION, {
      ...base,
      b2TokensAfter: BLOCK2_CEILING_TOKENS,
    });
    expect(report.epochMerges).toBe(0);
    expect(report.epochMergeDue).toBe(false);
    expect(mockJudgment).not.toHaveBeenCalled();
  });
});

describe("the epoch summarist's prompt", () => {
  beforeEach(() => {
    mockJudgment.mockReset();
  });

  it("states the ≤1.5k target and hands the model the era's beats", async () => {
    mockJudgment.mockResolvedValue({ summary: "  They lost the ship, and each other.  " } as never);
    const summary = await judgmentEpochSummarizer(SELECTION, {
      campaignId: "c1",
      turnNumber: 61,
    })([
      candidate(0, { content: "The bluff at the docks.", fromTurn: 1, toTurn: 5 }),
      candidate(1, { content: "The debt came due.", fromTurn: 6, toTurn: 12 }),
    ]);

    const opts = mockJudgment.mock.calls.at(-1)?.[1] as {
      system?: string;
      prompt?: string;
      name?: string;
      turnNumber?: number;
    };
    expect(opts?.name).toBe("epoch_summary");
    expect(opts?.system).toContain("1500 tokens");
    expect(opts?.system).toContain("SUBTEXT-FIRST");
    expect(opts?.prompt).toContain("turns 1–12");
    expect(opts?.prompt).toContain("The debt came due.");
    // The turn number IS the phase evidence — G2 spend files under its turn.
    expect(opts?.turnNumber).toBe(61);
    expect(summary).toBe("They lost the ship, and each other.");
  });
});

// ---------------------------------------------------------------------------
// Real Postgres: the merge as a state transition (§6.2 + §6.7 + §5.6)
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[epoch] DATABASE_URL not set — skipping real-DB suite");
}

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

/** One fat beat: `tokens` worth of content at `position`, spanning five turns. */
function beatRow(campaignId: string, position: number, tokens: number, isEpoch = false) {
  return {
    campaignId,
    content: "x".repeat(tokens * 4),
    isEpoch,
    fromTurn: position * 5 + 1,
    toTurn: position * 5 + 5,
    position,
    turnId: position * 5 + 5,
    provenance: isEpoch ? "epoch_merge_l1" : "chronicler_compaction",
    confidence: 1,
  };
}

describe.skipIf(!url)("epoch merge (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function seedCampaign(
    beats: { position: number; tokens: number; isEpoch?: boolean }[],
  ): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "epoch fixture" })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignIds.push(campaign.id);
    await db
      .insert(schema.compactedBeats)
      .values(beats.map((b) => beatRow(campaign.id, b.position, b.tokens, b.isEpoch)));
    return campaign.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "epoch@example.com" });
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

  beforeEach(() => {
    mockJudgment.mockReset();
  });

  it("fires on overflow: oldest half folded, originals tombstoned, ceiling met", async () => {
    if (!db) throw new Error("unreachable");
    // 12 beats × 900 tokens = 10.8k — over the 8k ceiling.
    const campaignId = await seedCampaign(
      Array.from({ length: 12 }, (_, i) => ({ position: i, tokens: 900 })),
    );
    mockJudgment.mockResolvedValue({ summary: "y".repeat(400) } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await maybeCompact(db, campaignId, 99, SELECTION);

    expect(report.epochMerges).toBe(1);
    expect(report.beatsMerged).toBe(6);
    expect(report.epochLevel).toBe(1);
    expect(report.epochMergeDue).toBe(false);
    expect(report.b2TokensAfter).toBeLessThanOrEqual(BLOCK2_CEILING_TOKENS);
    // One merge, not a loop: 6×900 + 100 lands under the ceiling on the first.
    expect(mockJudgment).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    const all = await db
      .select()
      .from(schema.compactedBeats)
      .where(eq(schema.compactedBeats.campaignId, campaignId));
    // §6.7: tombstoned, NEVER deleted — 12 originals + 1 epoch still on disk.
    expect(all).toHaveLength(13);
    const tombstoned = all.filter((r) => r.tombstonedAt !== null);
    expect(tombstoned).toHaveLength(6);
    expect(tombstoned.map((r) => r.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);

    const epoch = all.find((r) => r.isEpoch);
    expect(epoch?.provenance).toBe("epoch_merge_l1");
    expect(epoch?.position).toBe(0); // the merged span's position
    expect(epoch?.fromTurn).toBe(1);
    expect(epoch?.toTurn).toBe(30); // beats 0–5 span turns 1–30
    // The OLDEST constituent's turn id — the conservative stamp: only a
    // rewind reaching back before the era BEGAN removes the epoch. A mid-era
    // rewind keeps it whole (unreachable via the retake horizon; guarded
    // loudly in rewindCampaign — stack audit 2026-08-01).
    expect(epoch?.turnId).toBe(5);
    expect(await epochEventCount(db, campaignId)).toBe(1);
  });

  it("renders in position order with the epoch at its era's place", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = campaignIds.at(-1);
    if (!campaignId) throw new Error("no campaign");

    const beats = await loadBeats(db, campaignId);
    expect(beats).toHaveLength(7);
    expect(beats.map((b) => b.position)).toEqual([0, 6, 7, 8, 9, 10, 11]);
    expect(beats[0]?.isEpoch).toBe(true);
    expect(beats.slice(1).every((b) => !b.isEpoch)).toBe(true);

    // Byte-stability: the same rows must read back in the same order every
    // time, or Block 2 self-invalidates with no sanctioned event (§5.6).
    const again = await loadBeats(db, campaignId);
    expect(again).toEqual(beats);
    const render = (rows: typeof beats) =>
      assembleBlocks({ settei: "# S", beats: rows, exchanges: [], pins: [], watermark: 0 })
        .system[1]?.text;
    expect(render(again)).toBe(render(beats));
    expect(render([...beats].reverse())).toBe(render(beats));
  });

  it("invalidates Block 2 and nothing else (§5.6's sanctioned rewrite)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await seedCampaign(
      Array.from({ length: 12 }, (_, i) => ({ position: i, tokens: 900 })),
    );
    // A live window past the watermark (beats span turns 1–60), so Block 3 is
    // real prose rather than the empty case.
    await db.insert(schema.episodicRecords).values(
      Array.from({ length: 3 }, (_, i) => ({
        campaignId,
        turnNumber: 61 + i,
        playerInput: `input ${61 + i}`,
        narration: `Narration for turn ${61 + i}.`,
        turnId: 61 + i,
        provenance: "integration_test",
        confidence: 1,
      })),
    );
    const inputs = async () => ({
      settei: "# Settei",
      beats: await loadBeats(db, campaignId),
      exchanges: [{ turnNumber: 61, playerInput: "input 61", narration: "Narration for turn 61." }],
      pins: [],
      watermark: await compactionWatermark(db, campaignId),
    });
    const before = assembleBlocks(await inputs());
    expect(before.budgets.epochCount).toBe(0);

    mockJudgment.mockResolvedValue({ summary: "y".repeat(400) } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await maybeCompact(db, campaignId, 99, SELECTION);
    warn.mockRestore();
    expect(report.epochMerges).toBe(1);

    const after = assembleBlocks(await inputs());
    expect(after.system[0]?.text).toBe(before.system[0]?.text); // Block 1 untouched
    expect(block3Text(after.system)).toBe(block3Text(before.system)); // Block 3 untouched
    expect(after.system[1]?.text).not.toBe(before.system[1]?.text); // Block 2 rewritten
    expect(after.budgets.b2Tokens).toBeLessThan(before.budgets.b2Tokens);
    expect(after.budgets.epochCount).toBe(1);
    // The watermark is the load-bearing invariant: an epoch inherits its span's
    // toTurn, so the window cannot re-inflate with already-compacted turns.
    expect(await compactionWatermark(db, campaignId)).toBe(60);
  });

  it("re-merges epochs into a higher epoch (the century case)", async () => {
    if (!db) throw new Error("unreachable");
    // Two level-1 epochs, 5k tokens each — the state a few thousand turns in.
    const campaignId = await seedCampaign([
      { position: 0, tokens: 5_000, isEpoch: true },
      { position: 1, tokens: 5_000, isEpoch: true },
    ]);
    mockJudgment.mockResolvedValue({ summary: "z".repeat(2_000) } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await maybeCompact(db, campaignId, 500, SELECTION);
    warn.mockRestore();

    expect(report.epochMerges).toBe(1);
    expect(report.beatsMerged).toBe(2);
    expect(report.epochLevel).toBe(2);
    expect(report.epochMergeDue).toBe(false);

    const live = await db
      .select()
      .from(schema.compactedBeats)
      .where(
        and(
          eq(schema.compactedBeats.campaignId, campaignId),
          eq(schema.compactedBeats.isEpoch, true),
        ),
      );
    expect(live.find((r) => r.tombstonedAt === null)?.provenance).toBe("epoch_merge_l2");
    // Both level-1 rows were folded, not deleted.
    expect(live.filter((r) => r.tombstonedAt !== null)).toHaveLength(2);
    // The soak's detector counts FOLDED epochs too — it must only ever go up,
    // or a merge that consumed its predecessors would read as no merge at all.
    expect(await epochEventCount(db, campaignId)).toBe(3);
  });

  it("stops at the floor: one beat over the ceiling warns and stands", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await seedCampaign([{ position: 0, tokens: 9_000 }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await maybeCompact(db, campaignId, 99, SELECTION);

    expect(report.epochMerges).toBe(0);
    expect(report.epochMergeDue).toBe(true); // loud, not silent
    expect(report.b2TokensAfter).toBe(9_000);
    expect(mockJudgment).not.toHaveBeenCalled(); // no model call with nothing to merge
    const warned = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(warned).toContain("fewer than two beats");

    const rows = await db
      .select()
      .from(schema.compactedBeats)
      .where(
        and(
          eq(schema.compactedBeats.campaignId, campaignId),
          isNotNull(schema.compactedBeats.tombstonedAt),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("refuses a summary that does not shrink its span", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await seedCampaign(
      Array.from({ length: 12 }, (_, i) => ({ position: i, tokens: 900 })),
    );
    // 6 beats × 900 = 5400 tokens in; a 6000-token "summary" out. Accepting it
    // would let the loop re-merge the same era forever.
    mockJudgment.mockResolvedValue({ summary: "y".repeat(24_000) } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await maybeCompact(db, campaignId, 99, SELECTION);
    const warned = warn.mock.calls.flat().join(" ");
    warn.mockRestore();

    expect(report.epochMerges).toBe(0);
    expect(report.epochMergeDue).toBe(true);
    expect(await loadBeats(db, campaignId)).toHaveLength(12);
    expect(await epochEventCount(db, campaignId)).toBe(0);
    expect(warned).toContain("did not shrink");
  });

  it("is failure-isolated: a thrown summarist leaves Block 2 intact", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await seedCampaign(
      Array.from({ length: 12 }, (_, i) => ({ position: i, tokens: 900 })),
    );
    mockJudgment.mockRejectedValue(new Error("judgment tier unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Never throws: a compaction step is a G2 step, and G2 must not fail a turn.
    const report = await maybeCompact(db, campaignId, 99, SELECTION);
    const warned = warn.mock.calls.flat().join(" ");
    warn.mockRestore();

    expect(report.epochMerges).toBe(0);
    expect(report.epochMergeDue).toBe(true);
    expect(report.b2TokensAfter).toBe(10_800);
    const beats = await loadBeats(db, campaignId);
    expect(beats).toHaveLength(12);
    expect(beats.map((b) => b.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(await epochEventCount(db, campaignId)).toBe(0);
    expect(warned).toContain("epoch merge failed");
  });

  it("loops until under the ceiling, bounded per event", async () => {
    if (!db) throw new Error("unreachable");
    // 4 beats × 4k = 16k. One merge folds 2 → 8k + 1k = 9k, still over; the
    // second folds again. Proves the loop makes strict progress each pass.
    const campaignId = await seedCampaign(
      Array.from({ length: 4 }, (_, i) => ({ position: i, tokens: 4_000 })),
    );
    mockJudgment.mockResolvedValue({ summary: "y".repeat(4_000) } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await maybeCompact(db, campaignId, 99, SELECTION);
    warn.mockRestore();

    expect(report.epochMerges).toBe(2);
    expect(report.epochLevel).toBe(2);
    expect(report.epochMergeDue).toBe(false);
    expect(report.b2TokensAfter).toBeLessThanOrEqual(BLOCK2_CEILING_TOKENS);
  });

  it("a merge with an injected summarist needs no model at all", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await seedCampaign(
      Array.from({ length: 4 }, (_, i) => ({ position: i, tokens: 900 })),
    );
    const result = await runEpochMerge(db, campaignId, {
      summarizer: async (span) => `folded ${span.length} beats`,
    });

    expect(result.merged).toBe(true);
    expect(result.beatsMerged).toBe(2);
    expect(result.b2TokensAfter).toBe(1_800 + approxTokens("folded 2 beats"));
    expect(mockJudgment).not.toHaveBeenCalled();
  });
});
