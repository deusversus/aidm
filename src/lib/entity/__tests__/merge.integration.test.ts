import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mergeEntities } from "../merge";

/**
 * The merge primitive (§6.5, M2 C1) against real Postgres. Pins: block merge
 * (dupe material appends, verbatim-duplicate lines skipped), the state fold
 * (spotlightDebt max, relationships union with survivor precedence, interiority
 * sum), reversibility (dupe tombstoned not deleted, survivor version trail
 * intact), and merge-suggestion cleanup for the merged pair.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn("[entity/merge] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const ENV = { turnId: 1, provenance: "sz_compiler", confidence: 1 } as const;

describe.skipIf(!url)("Entity merge primitive (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "merge@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "Merge fixture", status: "active" })
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
    await db.delete(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    await db
      .update(schema.campaigns)
      .set({ directionState: null })
      .where(eq(schema.campaigns.id, campaignId));
  });

  async function seedPair() {
    if (!db) throw new Error("unreachable");
    const [survivor] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Kaz",
        entityType: "npc",
        block: "Kaz is a smuggler.\n- shared fact",
        state: {
          spotlightDebt: 2,
          relationships: { ally: "Jinx" },
          interiorityEvents: 3,
          scarTissue: "keep-me",
        },
        ...ENV,
      })
      .returning();
    const [dupe] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Kazuki",
        entityType: "npc",
        block: "- shared fact\n- dupe-only fact",
        state: {
          spotlightDebt: 5,
          relationships: { ally: "OVERRIDDEN", rival: "Vex" },
          interiorityEvents: 4,
          dupeOnly: "d",
        },
        turnId: 2,
        provenance: "player_assertion",
        confidence: 1,
      })
      .returning();
    if (!survivor || !dupe) throw new Error("seed failed");
    // A pre-existing survivor version so the merge stacks on top (max+1 = 2).
    await db
      .insert(schema.entityVersions)
      .values({ entityId: survivor.id, version: 1, block: survivor.block, ...ENV });
    return { survivor, dupe };
  }

  it("folds block + state and writes the survivor version row", async () => {
    if (!db) throw new Error("unreachable");
    const { survivor, dupe } = await seedPair();

    const result = await mergeEntities(db, {
      campaignId,
      survivorId: survivor.id,
      dupeId: dupe.id,
      provenance: "merge:player",
      turnId: 10,
    });

    expect(result.versionWritten).toBe(2);
    // Block: dupe's non-duplicate material appends; the shared line stays once.
    expect(result.mergedBlock).toContain("Kaz is a smuggler.");
    expect(result.mergedBlock).toContain("- dupe-only fact");
    expect(result.mergedBlock.match(/- shared fact/g)).toHaveLength(1);

    const [merged] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, survivor.id));
    const state = merged?.state as Record<string, unknown>;
    expect(state.spotlightDebt).toBe(5); // max(2, 5)
    expect(state.relationships).toEqual({ ally: "Jinx", rival: "Vex" }); // survivor precedence per key
    expect(state.interiorityEvents).toBe(7); // 3 + 4
    expect(state.scarTissue).toBe("keep-me"); // survivor-only key survives
    expect(state.dupeOnly).toBe("d"); // dupe-only key carries over
    expect(merged?.block).toBe(result.mergedBlock);
  });

  it("is reversible: the dupe is tombstoned (not deleted) and the version trail is intact", async () => {
    if (!db) throw new Error("unreachable");
    const { survivor, dupe } = await seedPair();

    await mergeEntities(db, {
      campaignId,
      survivorId: survivor.id,
      dupeId: dupe.id,
      provenance: "merge:janitor",
      turnId: 12,
    });

    // The dupe ROW still exists — tombstoned, never deleted (§6.7 rewind base).
    const [dupeRow] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, dupe.id));
    expect(dupeRow).toBeDefined();
    expect(dupeRow?.tombstonedAt).not.toBeNull();

    // Survivor version trail: v1 (original) preserved + v2 (merged) appended.
    const versions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, survivor.id))
      .orderBy(schema.entityVersions.version);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.block).toBe("Kaz is a smuggler.\n- shared fact");
    expect(versions[1]?.version).toBe(2);
    expect(versions[1]?.turnId).toBe(12);
    expect(versions[1]?.provenance).toBe("merge:janitor");
    expect(versions[1]?.confidence).toBe(1);
  });

  it("removes any merge_suggestion referencing either merged id, keeping unrelated ones", async () => {
    if (!db) throw new Error("unreachable");
    const { survivor, dupe } = await seedPair();
    const unrelatedA = crypto.randomUUID();
    const unrelatedB = crypto.randomUUID();
    await db
      .update(schema.campaigns)
      .set({
        directionState: {
          merge_suggestions: [
            {
              survivor_id: survivor.id,
              dupe_id: dupe.id,
              survivor_name: "Kaz",
              dupe_name: "Kazuki",
              entity_type: "npc",
              reason: "same smuggler",
              confidence: 0.7,
              at_turn: 4,
            },
            {
              survivor_id: unrelatedA,
              dupe_id: unrelatedB,
              survivor_name: "Vex",
              dupe_name: "Vexx",
              entity_type: "npc",
              reason: "unrelated pair",
              confidence: 0.6,
              at_turn: 4,
            },
          ],
        },
      })
      .where(eq(schema.campaigns.id, campaignId));

    await mergeEntities(db, {
      campaignId,
      survivorId: survivor.id,
      dupeId: dupe.id,
      provenance: "merge:player",
      turnId: 10,
    });

    const [row] = await db
      .select({ directionState: schema.campaigns.directionState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const suggestions = (row?.directionState as { merge_suggestions?: unknown[] })
      ?.merge_suggestions as Array<{ survivor_id: string }> | undefined;
    expect(suggestions).toHaveLength(1);
    expect(suggestions?.[0]?.survivor_id).toBe(unrelatedA);
  });
});
