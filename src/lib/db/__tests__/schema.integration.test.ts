import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notTombstoned } from "../helpers";
import * as schema from "../schema";

/**
 * Integration tests against the real dev Postgres (aidm_v5) — or the CI
 * pgvector container. No mocks; this suite is the C3 exit gate. Skipped
 * (loudly) only when no DATABASE_URL is configured at all.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[schema.integration] DATABASE_URL not set — skipping real-DB suite");
}

// Own pool, not getDb(): the singleton has no teardown surface, and these
// tests must close their connections so vitest exits cleanly.
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const envelope = (turnId: number) => ({
  turnId,
  provenance: "integration_test",
  confidence: 1,
});

/** One-hot at index `seed` — distinct seeds are orthogonal, so cosine ordering is well-defined. */
const vec = (seed: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));

describe.skipIf(!url)("v5 schema (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  // Randomized: canon_chunks is profile-keyed (no campaign FK), so the
  // campaign-cascade cleanup can't reach it — a real profile id here would
  // leak fake lore into the dev DB on every run.
  const testProfileId = `test_profile_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "test@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "integration fixture" })
      .returning();
    if (!campaign) throw new Error("campaign insert returned nothing");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      if (campaignId) {
        // model_calls is onDelete: set-null (the cost ledger survives campaign
        // deletion by design) — delete test rows BEFORE the campaign goes.
        await db.delete(schema.modelCalls).where(eq(schema.modelCalls.campaignId, campaignId));
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      }
      // Profile-keyed, outside the cascade.
      await db.delete(schema.canonChunks).where(eq(schema.canonChunks.profileId, testProfileId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("vector columns agree with the frozen EMBEDDING_DIMENSIONS constant", async () => {
    if (!db) throw new Error("unreachable");
    const result = await db.execute(sql`
      SELECT a.atttypmod AS dims, c.relname
      FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid
      WHERE c.relname IN ('semantic_memories', 'canon_chunks') AND a.attname = 'embedding'
    `);
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(Number(row.dims)).toBe(EMBEDDING_DIMENSIONS);
    }
  });

  it("every layer table round-trips a provenance-enveloped write", async () => {
    if (!db) throw new Error("unreachable");

    await db.insert(schema.compactedBeats).values({
      campaignId,
      content: "beat",
      fromTurn: 1,
      toTurn: 10,
      position: 0,
      ...envelope(10),
    });
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 1,
      playerInput: "I light a cigarette.",
      narration: "The match flares.",
      ...envelope(1),
    });
    await db.insert(schema.semanticMemories).values({
      campaignId,
      content: "The Syndicate has a new leader called Slayer.",
      embedding: vec(1),
      category: "faction",
      ...envelope(2),
    });
    await db.insert(schema.canonChunks).values({
      profileId: testProfileId,
      pageType: "character",
      title: "Spike Spiegel",
      content: "Former Syndicate hitman.",
      embedding: vec(2),
      ...envelope(0),
    });
    const [entity] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Slayer",
        entityType: "npc",
        block: "New Syndicate leader; unseen.",
        ...envelope(2),
      })
      .returning();
    if (!entity) throw new Error("entity insert returned nothing");
    await db.insert(schema.entityVersions).values({
      entityId: entity.id,
      version: 1,
      block: "New Syndicate leader; unseen.",
      ...envelope(2),
    });
    await db.insert(schema.quests).values({
      campaignId,
      name: "Find the bounty on Terra Firma",
      ...envelope(2),
    });
    await db.insert(schema.arcs).values({
      campaignId,
      name: "The Syndicate Closes In",
      stratum: "arc",
      dramaticQuestion: "Can the past stay buried?",
      shape: "rising",
      budget: { unit: "episodes", target: 3, tolerance: 1 },
      phase: "setup",
      ...envelope(2),
    });
    await db.insert(schema.seeds).values({
      campaignId,
      description: "Slayer knows Spike's name.",
      plantedTurn: 2,
      ...envelope(2),
    });
    await db.insert(schema.consequences).values({
      campaignId,
      description: "The raiders on Terra Firma grow bolder.",
      ...envelope(2),
    });
    await db.insert(schema.sessionRecords).values({
      campaignId,
      sessionNumber: 1,
      ...envelope(3),
    });
    await db.insert(schema.criticalFacts).values({
      campaignId,
      content: "Finitude: finite — this story trends toward an end.",
      category: "contract",
      ...envelope(0),
    });
    await db.insert(schema.overrides).values({
      campaignId,
      content: "Ed is never written out of the crew.",
      ...envelope(3),
    });
    await db.insert(schema.pins).values({
      campaignId,
      content: "Whatever happens, happens.",
      ...envelope(3),
    });

    // The read half of the round-trip: every layer table selects back with
    // the envelope intact. entity_versions is entity-scoped; canon_chunks is
    // profile-scoped; the other twelve are campaign-scoped.
    const byCampaign = [
      ["compacted_beats", schema.compactedBeats],
      ["episodic_records", schema.episodicRecords],
      ["semantic_memories", schema.semanticMemories],
      ["entities", schema.entities],
      ["quests", schema.quests],
      ["arcs", schema.arcs],
      ["seeds", schema.seeds],
      ["consequences", schema.consequences],
      ["session_records", schema.sessionRecords],
      ["critical_facts", schema.criticalFacts],
      ["overrides", schema.overrides],
      ["pins", schema.pins],
    ] as const;
    for (const [name, table] of byCampaign) {
      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.campaignId, campaignId), notTombstoned(table)));
      expect(rows.length, `${name} read-back`).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.provenance, `${name} provenance`).toBe("integration_test");
      expect(rows[0]?.confidence, `${name} confidence`).toBe(1);
      expect(rows[0]?.tombstonedAt, `${name} tombstone default`).toBeNull();
      expect(typeof rows[0]?.turnId, `${name} turnId`).toBe("number");
    }

    const versions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, entity.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.provenance).toBe("integration_test");

    const chunks = await db
      .select()
      .from(schema.canonChunks)
      .where(eq(schema.canonChunks.profileId, testProfileId));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.turnId).toBe(0);
  });

  it("pencil-mark supersession: the old mark is demoted, the refinement stays renderable", async () => {
    if (!db) throw new Error("unreachable");
    const [oldMark] = await db
      .insert(schema.pencilMarks)
      .values({
        campaignId,
        kind: "axis",
        topic: "emotional_register",
        direction: "less flowery",
        evidence: "player, turn 2",
        ...envelope(2),
      })
      .returning();
    if (!oldMark) throw new Error("mark insert returned nothing");
    const [newMark] = await db
      .insert(schema.pencilMarks)
      .values({
        campaignId,
        kind: "axis",
        topic: "emotional_register",
        direction: "hold restraint in payoffs too",
        evidence: "meta booth, turn 3",
        ...envelope(3),
      })
      .returning();
    if (!newMark) throw new Error("mark insert returned nothing");
    // Supersession points FROM the demoted mark TO its successor (§6.6):
    // the old row is kept for provenance, excluded from rendering.
    await db
      .update(schema.pencilMarks)
      .set({ supersededBy: newMark.id })
      .where(eq(schema.pencilMarks.id, oldMark.id));

    const renderable = await db
      .select()
      .from(schema.pencilMarks)
      .where(
        and(
          eq(schema.pencilMarks.campaignId, campaignId),
          eq(schema.pencilMarks.topic, "emotional_register"),
          isNull(schema.pencilMarks.supersededBy),
        ),
      );
    expect(renderable).toHaveLength(1);
    expect(renderable[0]?.direction).toBe("hold restraint in payoffs too");
  });

  it("spine round-trip: turn checkpoint, snapshot, model call, rewind event", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 1,
      tier: "genga",
      status: "complete",
      playerInput: "I light a cigarette.",
      conte: { turn_id: 1, tier: "genga" },
      checkpoints: { phase_a: true, group_1: true },
    });
    // Durable-job identity: one row per (campaign, turnNumber).
    await expect(
      db.insert(schema.turns).values({
        campaignId,
        turnNumber: 1,
        tier: "douga",
        playerInput: "duplicate",
      }),
    ).rejects.toThrow();

    await db.insert(schema.stateSnapshots).values({
      campaignId,
      turnNumber: 5,
      state: { hp: 10 },
    });
    const snapshots = await db
      .select()
      .from(schema.stateSnapshots)
      .where(eq(schema.stateSnapshots.campaignId, campaignId));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.state).toEqual({ hp: 10 });

    await db.insert(schema.modelCalls).values({
      campaignId,
      turnNumber: 1,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "narration",
      inputTokens: 12000,
      outputTokens: 900,
      cacheReadInputTokens: 11000,
      costUsd: "0.021600",
    });
    await db.insert(schema.rewinds).values({
      campaignId,
      rewoundToTurn: 0,
      tombstonedCount: 0,
    });

    const calls = await db
      .select()
      .from(schema.modelCalls)
      .where(eq(schema.modelCalls.campaignId, campaignId));
    expect(calls[0]?.cacheReadInputTokens).toBe(11000);
    expect(Number(calls[0]?.costUsd)).toBeCloseTo(0.0216);
  });

  it("tombstone rewind semantics: writes past N vanish behind notTombstoned(), re-writes are not blocked", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.semanticMemories).values({
      campaignId,
      content: "A fact from turn 8 the player regrets.",
      embedding: vec(3),
      category: "event",
      ...envelope(8),
    });
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 8,
      playerInput: "the regretted action",
      narration: "the regretted scene",
      ...envelope(8),
    });

    // Rewind to turn 5: tombstone layer writes with turnId > 5.
    const rewindTo = 5;
    for (const table of [schema.semanticMemories, schema.episodicRecords] as const) {
      await db
        .update(table)
        .set({ tombstonedAt: new Date() })
        .where(and(eq(table.campaignId, campaignId), gt(table.turnId, rewindTo)));
    }

    const visible = await db
      .select()
      .from(schema.semanticMemories)
      .where(
        and(
          eq(schema.semanticMemories.campaignId, campaignId),
          notTombstoned(schema.semanticMemories),
        ),
      );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.turnId).toBe(2);

    // Provenance retention: the tombstoned rows still exist for the record.
    const all = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    expect(all).toHaveLength(2);

    // The partial unique index (§6.7 fix): the replayed turn 8 can insert a
    // fresh episodic record while the tombstoned turn-8 row remains.
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 8,
      playerInput: "the new timeline's action",
      narration: "the new timeline's scene",
      ...envelope(8),
    });
    const visibleEpisodic = await db
      .select()
      .from(schema.episodicRecords)
      .where(
        and(
          eq(schema.episodicRecords.campaignId, campaignId),
          eq(schema.episodicRecords.turnNumber, 8),
          notTombstoned(schema.episodicRecords),
        ),
      );
    expect(visibleEpisodic).toHaveLength(1);
    expect(visibleEpisodic[0]?.narration).toBe("the new timeline's scene");
  });

  it("pgvector cosine ordering ranks orthogonal candidates correctly and skips tombstoned rows", async () => {
    if (!db) throw new Error("unreachable");
    // A second visible candidate, orthogonal to the Slayer memory (vec(1)).
    await db.insert(schema.semanticMemories).values({
      campaignId,
      content: "Jet keeps bonsai on the Bebop.",
      embedding: vec(5),
      category: "character",
      ...envelope(3),
    });

    const probe = JSON.stringify(vec(1));
    const result = await db.execute(sql`
      SELECT content, embedding <=> ${probe}::vector AS distance
      FROM semantic_memories
      WHERE campaign_id = ${campaignId} AND tombstoned_at IS NULL
      ORDER BY distance ASC
    `);
    // Exactly the two visible rows — the tombstoned turn-8 memory is absent.
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.content).toContain("Slayer");
    expect(result.rows[1]?.content).toContain("bonsai");
    expect(Number(result.rows[0]?.distance)).toBeLessThan(Number(result.rows[1]?.distance));

    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'semantic_memories' AND indexdef ILIKE '%hnsw%'
    `);
    expect(indexes.rows).toHaveLength(1);
  });
});
