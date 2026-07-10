import { notTombstoned } from "@/lib/db/helpers";
import * as schema from "@/lib/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRewindGuards, rewindCampaign, writeSnapshotIfDue } from "../rewind";

/**
 * Rewind end-to-end (§6.7) against real Postgres — no model calls (rewind is
 * pure code). Proves: tombstoning across ≥4 layer tables with notTombstoned()
 * exclusion + logged count; the partial-index re-insert in anger; snapshot
 * restore + G1 resource-spend replay; dead-timeline turns/heat-boost deletion;
 * and the bounded-UX guards (unit, no DB).
 */

// --- Guards: pure logic, always runs (no DB) --------------------------------

describe("rewind guards (§6.7 bounded UX)", () => {
  it("rejects a rewind deeper than 10 turns from the play view", () => {
    const r = checkRewindGuards({ toTurn: 3, currentMax: 20, hasOpenTurn: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("bounded to 10");
    }
  });

  it("rejects a rewind while a turn is open (409)", () => {
    const r = checkRewindGuards({ toTurn: 5, currentMax: 8, hasOpenTurn: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("rejects a negative toTurn (400)", () => {
    const r = checkRewindGuards({ toTurn: -1, currentMax: 8, hasOpenTurn: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects rewinding to the latest turn or beyond (400)", () => {
    expect(checkRewindGuards({ toTurn: 8, currentMax: 8, hasOpenTurn: false }).ok).toBe(false);
    expect(checkRewindGuards({ toTurn: 9, currentMax: 8, hasOpenTurn: false }).ok).toBe(false);
  });

  it("admits a valid in-window rewind", () => {
    expect(checkRewindGuards({ toTurn: 5, currentMax: 8, hasOpenTurn: false })).toEqual({
      ok: true,
    });
    // Exactly 10 deep is allowed; 11 is not.
    expect(checkRewindGuards({ toTurn: 5, currentMax: 15, hasOpenTurn: false }).ok).toBe(true);
    expect(checkRewindGuards({ toTurn: 5, currentMax: 16, hasOpenTurn: false }).ok).toBe(false);
  });
});

// --- The rewind itself: real Postgres ---------------------------------------

const url = process.env.DATABASE_URL;
if (!url) console.warn("[rewind] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const envelope = (turnId: number) => ({ turnId, provenance: "rewind_test", confidence: 1 });
/** One-hot basis vector — orthogonal seeds keep ANN ordering well-defined (unused here, but the column is NOT NULL). */
const vec = (seed: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));

const spendConte = (turnNumber: number, amount: number) => ({
  turn_id: turnNumber,
  tier: "genga",
  mechanics: { rolls: [], resource_spends: [{ resource: "MP", amount }] },
});

type MpState = { resources?: { MP?: { current?: number; max?: number } } } | undefined;

describe("rewindDirectionState (pure, §6.7 + C8 re-audit)", () => {
  it("clamps turn-anchored fields, drops dead-timeline evidence, keeps soft state", async () => {
    const { DirectionState, rewindDirectionState } = await import("@/lib/types/direction");
    const state = DirectionState.parse({
      last_director_turn: 20,
      accumulated_epicness: 1.4,
      arc_events: ["sakuga_moment"],
      tension_level: 0.7,
      director_notes: ["hold the noir patience"],
      phase_state: { arc_id: "a1", phase: "rising", entered_at_turn: 14 },
      settei: {
        text: "x",
        charter_tokens: 10,
        rendered_axes: ["darkness"],
        uncovered_extremes: [],
        rebuilt_at_turn: 20,
        rebuilt_at: "2026-07-09T00:00:00.000Z",
      },
      sakkan: {
        last_sample_turn: 20,
        readings: {
          darkness: {
            observed: 3,
            confidence: 0.9,
            at_turn: 16,
            consecutive_drift: 2,
            evidence: "e",
          },
          comedy: { observed: 5, confidence: 0.8, at_turn: 8, consecutive_drift: 0, evidence: "e" },
        },
        active_notes: [
          { axis: "darkness", active: 7, observed: 3, since_turn: 16 },
          { axis: "comedy", active: 4, observed: 6, since_turn: 9 },
        ],
      },
    });

    const rewound = rewindDirectionState(state, 10);

    // Turn anchors clamp to the surviving timeline — the Sakkan's same-turn
    // guard and the Director's turns_since both work again from turn 11.
    expect(rewound.last_director_turn).toBe(10);
    expect(rewound.sakkan?.last_sample_turn).toBe(10);
    expect(rewound.phase_state?.entered_at_turn).toBe(10);
    expect(rewound.settei?.rebuilt_at_turn).toBe(10);
    // Dead-timeline evidence drops; surviving evidence stays.
    expect(rewound.sakkan?.readings.darkness).toBeUndefined();
    expect(rewound.sakkan?.readings.comedy).toBeDefined();
    expect(rewound.sakkan?.active_notes).toEqual([
      { axis: "comedy", active: 4, observed: 6, since_turn: 9 },
    ]);
    // Accumulators reset (their evidence may be un-happened); soft state survives.
    expect(rewound.accumulated_epicness).toBe(0);
    expect(rewound.arc_events).toEqual([]);
    expect(rewound.tension_level).toBeCloseTo(0.7);
    expect(rewound.director_notes).toEqual(["hold the noir patience"]);
  });
});

describe.skipIf(!url)("rewindCampaign (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "rewind@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Rewind fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: {
          narration: "claude-sonnet-5",
          judgment: "claude-sonnet-5",
          probe: "claude-haiku-4-5",
        },
      })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      // Campaign cascade reaches every campaign-scoped layer table.
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    // Each test owns a clean campaign. Delete children before parents; entity
    // deletes cascade to entity_versions, memory deletes cascade to boosts.
    await db.delete(schema.heatBoosts).where(eq(schema.heatBoosts.campaignId, campaignId));
    await db.delete(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    await db
      .delete(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    await db
      .delete(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
    await db.delete(schema.seeds).where(eq(schema.seeds.campaignId, campaignId));
    await db.delete(schema.consequences).where(eq(schema.consequences.campaignId, campaignId));
    await db.delete(schema.stateSnapshots).where(eq(schema.stateSnapshots.campaignId, campaignId));
    await db.delete(schema.rewinds).where(eq(schema.rewinds.campaignId, campaignId));
    await db.delete(schema.turns).where(eq(schema.turns.campaignId, campaignId));
  });

  it("tombstones layer writes past N across ≥4 tables; notTombstoned() excludes them; count logged", async () => {
    if (!db) throw new Error("unreachable");
    // Batched inserts (one round-trip per table) — the remote dev DB makes
    // 32 sequential inserts latency-bound, not the code under test.
    const nums = [1, 2, 3, 4, 5, 6, 7, 8];
    await db.insert(schema.episodicRecords).values(
      nums.map((t) => ({
        campaignId,
        turnNumber: t,
        playerInput: `in ${t}`,
        narration: `out ${t}`,
        ...envelope(t),
      })),
    );
    await db.insert(schema.semanticMemories).values(
      nums.map((t) => ({
        campaignId,
        content: `fact ${t}`,
        embedding: vec(t),
        category: "fact",
        ...envelope(t),
      })),
    );
    await db.insert(schema.seeds).values(
      nums.map((t) => ({
        campaignId,
        description: `seed ${t}`,
        status: "planted",
        plantedTurn: t,
        ...envelope(t),
      })),
    );
    await db
      .insert(schema.consequences)
      .values(nums.map((t) => ({ campaignId, description: `consequence ${t}`, ...envelope(t) })));

    const result = await rewindCampaign(db, campaignId, 5, "regret");
    // 3 rows (turnId 6,7,8) tombstoned per table × 4 tables = 12.
    expect(result.tombstonedCount).toBe(12);
    expect(result.snapshotTurn).toBeNull();
    expect(result.nonReversible).toEqual(["model spend"]);

    // Episodic: full tombstone semantics — turnId>5 flagged, ≤5 untouched.
    const epiAll = await db
      .select()
      .from(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
    expect(epiAll).toHaveLength(8);
    for (const r of epiAll) expect(r.tombstonedAt === null).toBe(r.turnId <= 5);
    const epiVisible = await db
      .select()
      .from(schema.episodicRecords)
      .where(
        and(
          eq(schema.episodicRecords.campaignId, campaignId),
          notTombstoned(schema.episodicRecords),
        ),
      );
    expect(epiVisible).toHaveLength(5);

    // The other three layers: notTombstoned() reads exclude the dead timeline.
    const semVisible = await db
      .select()
      .from(schema.semanticMemories)
      .where(
        and(
          eq(schema.semanticMemories.campaignId, campaignId),
          notTombstoned(schema.semanticMemories),
        ),
      );
    expect(semVisible).toHaveLength(5);
    const seedVisible = await db
      .select()
      .from(schema.seeds)
      .where(and(eq(schema.seeds.campaignId, campaignId), notTombstoned(schema.seeds)));
    expect(seedVisible).toHaveLength(5);
    const consVisible = await db
      .select()
      .from(schema.consequences)
      .where(
        and(eq(schema.consequences.campaignId, campaignId), notTombstoned(schema.consequences)),
      );
    expect(consVisible).toHaveLength(5);

    // The event log carries the tombstone count and the target.
    const [log] = await db
      .select()
      .from(schema.rewinds)
      .where(eq(schema.rewinds.campaignId, campaignId));
    expect(log?.rewoundToTurn).toBe(5);
    expect(log?.tombstonedCount).toBe(12);
    expect(log?.reason).toBe("regret");
  }, 20_000);

  it("the partial unique index lets a replayed turn re-insert at the same (campaign, turnNumber)", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 6,
      playerInput: "old",
      narration: "old timeline",
      ...envelope(6),
    });

    await rewindCampaign(db, campaignId, 5);

    // The old turn-6 row is tombstoned; the replayed turn 6 must be able to
    // insert a fresh record — this is exactly why the index is partial
    // WHERE tombstoned_at IS NULL. A full unique index would throw here.
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 6,
      playerInput: "new",
      narration: "new timeline",
      ...envelope(6),
    });

    const all = await db
      .select()
      .from(schema.episodicRecords)
      .where(
        and(
          eq(schema.episodicRecords.campaignId, campaignId),
          eq(schema.episodicRecords.turnNumber, 6),
        ),
      );
    expect(all).toHaveLength(2);
    const visible = await db
      .select()
      .from(schema.episodicRecords)
      .where(
        and(
          eq(schema.episodicRecords.campaignId, campaignId),
          eq(schema.episodicRecords.turnNumber, 6),
          notTombstoned(schema.episodicRecords),
        ),
      );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.narration).toBe("new timeline");
  }, 20_000);

  it("restores the nearest snapshot ≤ N and replays G1 resource spends forward", async () => {
    if (!db) throw new Error("unreachable");
    // Player-character entity created early (turnId 1) so it survives rewinds.
    // Its LIVE state (post-spends) is deliberately wrong — rewind reconstructs.
    const [pc] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Spike",
        entityType: "player",
        state: { resources: { MP: { current: 40, max: 100 } } },
        ...envelope(1),
      })
      .returning({ id: schema.entities.id });
    if (!pc) throw new Error("pc insert failed");

    // Snapshot at turn 5 captured MP full.
    await db.insert(schema.stateSnapshots).values({
      campaignId,
      turnNumber: 5,
      state: { entities: { [pc.id]: { resources: { MP: { current: 100, max: 100 } } } } },
    });
    // Turns 6 and 7 each spent 20 MP, recorded in the conte.
    for (const t of [6, 7]) {
      await db.insert(schema.turns).values({
        campaignId,
        turnNumber: t,
        tier: "genga",
        status: "complete",
        playerInput: `spend ${t}`,
        conte: spendConte(t, 20),
      });
    }

    await rewindCampaign(db, campaignId, 7);
    const [afterSeven] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, pc.id));
    expect((afterSeven?.state as MpState)?.resources?.MP?.current).toBe(60); // 100 − 20 − 20
    expect((afterSeven?.state as MpState)?.resources?.MP?.max).toBe(100); // untouched keys survive

    // Rewind further to 5: no spends in (5,5] → the snapshot value stands.
    await rewindCampaign(db, campaignId, 5);
    const [afterFive] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, pc.id));
    expect((afterFive?.state as MpState)?.resources?.MP?.current).toBe(100);
  }, 20_000);

  it("deletes the dead-timeline turns and the unapplied heat-boost accumulator past N", async () => {
    if (!db) throw new Error("unreachable");
    const [mem] = await db
      .insert(schema.semanticMemories)
      .values({ campaignId, content: "m", embedding: vec(1), category: "fact", ...envelope(1) })
      .returning({ id: schema.semanticMemories.id });
    if (!mem) throw new Error("mem insert failed");

    const nums = [1, 2, 3, 4, 5, 6, 7, 8];
    await db.insert(schema.turns).values(
      nums.map((t) => ({
        campaignId,
        turnNumber: t,
        tier: "genga",
        status: "complete",
        playerInput: `t${t}`,
      })),
    );
    await db
      .insert(schema.heatBoosts)
      .values(nums.map((t) => ({ campaignId, memoryId: mem.id, boost: 5, turnNumber: t })));

    await rewindCampaign(db, campaignId, 5);

    const turns = await db
      .select({ n: schema.turns.turnNumber })
      .from(schema.turns)
      .where(eq(schema.turns.campaignId, campaignId));
    expect(turns.map((t) => t.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    const boosts = await db
      .select({ n: schema.heatBoosts.turnNumber })
      .from(schema.heatBoosts)
      .where(eq(schema.heatBoosts.campaignId, campaignId));
    expect(boosts.map((b) => b.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  }, 20_000);

  it("writeSnapshotIfDue snapshots catalog state every 5th turn (idempotently); rewind reads it back", async () => {
    if (!db) throw new Error("unreachable");
    const [pc] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Faye",
        entityType: "player",
        state: { resources: { MP: { current: 100, max: 100 } } },
        ...envelope(1),
      })
      .returning({ id: schema.entities.id });
    if (!pc) throw new Error("pc insert failed");

    await writeSnapshotIfDue(db, campaignId, 4); // not a multiple of 5 — no-op
    let snaps = await db
      .select()
      .from(schema.stateSnapshots)
      .where(eq(schema.stateSnapshots.campaignId, campaignId));
    expect(snaps).toHaveLength(0);

    await writeSnapshotIfDue(db, campaignId, 5);
    await writeSnapshotIfDue(db, campaignId, 5); // idempotent — overwrites, no duplicate
    snaps = await db
      .select()
      .from(schema.stateSnapshots)
      .where(eq(schema.stateSnapshots.campaignId, campaignId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.turnNumber).toBe(5);

    // A spend at turn 6, then rewind to 6: the reader restores the writer's
    // payload (MP 100) and replays the −20 → 80.
    await db
      .update(schema.entities)
      .set({ state: { resources: { MP: { current: 10, max: 100 } } } })
      .where(eq(schema.entities.id, pc.id));
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 6,
      tier: "genga",
      status: "complete",
      playerInput: "spend",
      conte: spendConte(6, 20),
    });

    const result = await rewindCampaign(db, campaignId, 6);
    expect(result.snapshotTurn).toBe(5);
    const [restored] = await db.select().from(schema.entities).where(eq(schema.entities.id, pc.id));
    expect((restored?.state as MpState)?.resources?.MP?.current).toBe(80);
  }, 20_000);
});
