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

  it("an out-of-band confidence PINS instead of throwing the review (2026-08-01)", async () => {
    if (!db) throw new Error("unreachable");
    // The grammar strips minimum/maximum alongside the length bounds, so
    // `.min(0).max(1)` could only ever fail the parse and take the whole
    // close-time review (or the mint-time resolver guard) with it. The verdict
    // is read only through the merge thresholds, so pinning is lossless.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({ same: true, confidence: 1.4, reason: "certain beyond certainty" } as never),
    );
    const [older] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "The Ashen Vault",
        entityType: "location",
        block: "A vault under the ash flats.",
        turnId: 1,
        ...ENV,
      })
      .returning();
    const [newer] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Vault beneath the ash flats",
        entityType: "location",
        block: "The same vault, named twice.",
        turnId: 2,
        ...ENV,
      })
      .returning();
    if (!older || !newer) throw new Error("seed failed");

    const report = await reviewCatalog(db, campaignId, 7, DEV_TIER_SELECTION);

    // Pinned to 1.0 → still above MERGE_AUTO, so the review completed normally.
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]?.survivorId).toBe(older.id);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // --- The SEMANTIC candidate tier (M2 C1 deferral, landed M3R4 B3) ---------
  // The VERDICT was always semantic; the FILTER in front of it read names
  // alone, so a pair sharing a meaning and no wording never reached the probe.

  /** Names sit on orthogonal basis vectors (distance 1); the meaning vectors
   *  — name + block head — collide on basis(0). Only the second tier can see
   *  this pair, which is the whole point. */
  function armDivergentNamesSameMeaning() {
    mockEmbed.mockImplementation(async (texts: string[]) =>
      texts.map((t, i) => (t.includes("—") ? basis(0) : basis(i + 1))),
    );
  }

  it("different names, same meaning: the pair the NAME filter hides still reaches the probe", async () => {
    if (!db) throw new Error("unreachable");
    armDivergentNamesSameMeaning();
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({
        same: true,
        confidence: 0.95,
        reason: "one syndicate, two names",
      } as never),
    );
    const [older] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "The Red Sash",
        entityType: "faction",
        block: "The dockworkers' syndicate that runs the piers.",
        turnId: 1,
        ...ENV,
      })
      .returning();
    const [newer] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "The dockworkers' syndicate",
        entityType: "faction",
        block: "The syndicate of dockworkers controlling the piers.",
        turnId: 2,
        ...ENV,
      })
      .returning();
    if (!older || !newer) throw new Error("seed failed");

    const report = await reviewCatalog(db, campaignId, 9, DEV_TIER_SELECTION);

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]?.survivorId).toBe(older.id);
    expect(report.merged[0]?.dupeId).toBe(newer.id);

    // ATTRIBUTION (B3 audit R2c): the version row names the FILTER that offered
    // the pair, not just "the janitor" — the permissive semantic threshold is
    // unmeasured, so a bad auto-merge from it has to be traceable to it.
    const [version] = await db
      .select({ provenance: schema.entityVersions.provenance })
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, older.id));
    expect(version?.provenance).toBe("merge:janitor:semantic");
  });

  it("the meaning embed failing degrades to the NAME tier — the review never becomes a no-op", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Names collide (the shipped tier sees the pair); the MEANING request — the
    // second call, per the sequencing — rejects.
    let call = 0;
    mockEmbed.mockImplementation(async (texts: string[]) => {
      call += 1;
      if (call === 2) throw new Error("voyage 429");
      return texts.map(() => basis(0));
    });
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({ same: true, confidence: 0.96, reason: "one vault" } as never),
    );
    const [older] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "The Ashen Vault",
        entityType: "location",
        block: "A vault under the ash flats.",
        turnId: 1,
        ...ENV,
      })
      .returning();
    const [newer] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Ashen Vault",
        entityType: "location",
        block: "The same vault, named twice.",
        turnId: 2,
        ...ENV,
      })
      .returning();
    if (!older || !newer) throw new Error("seed failed");

    const report = await reviewCatalog(db, campaignId, 12, DEV_TIER_SELECTION);

    // The shipped tier's merge lands anyway, and it is attributed to the NAME tier.
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]?.survivorId).toBe(older.id);
    const [version] = await db
      .select({ provenance: schema.entityVersions.provenance })
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, older.id));
    expect(version?.provenance).toBe("merge:janitor");
    expect(warn).toHaveBeenCalledWith(
      "[janitor] meaning embed failed — the NAME tier reviews alone this close",
      expect.objectContaining({ campaignId }),
    );
    warn.mockRestore();
  });

  it("the meaning vector reads name AND block head, never the name alone", async () => {
    if (!db) throw new Error("unreachable");
    armDivergentNamesSameMeaning();
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({ same: false, confidence: 0.1, reason: "distinct" } as never),
    );
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "The Red Sash",
        entityType: "faction",
        block: "The dockworkers' syndicate that runs the piers.",
        turnId: 1,
        ...ENV,
      },
      {
        campaignId,
        name: "The dockworkers' syndicate",
        entityType: "faction",
        block: "The syndicate of dockworkers controlling the piers.",
        turnId: 2,
        ...ENV,
      },
    ]);

    await reviewCatalog(db, campaignId, 10, DEV_TIER_SELECTION);

    // Two batches per type group: the shipped name vector, and the meaning one.
    // (The catalog select has no ORDER BY, so assert on contents, not order.)
    const batches = mockEmbed.mock.calls.map((c) => (c[0] as string[]).slice().sort());
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["The Red Sash", "The dockworkers' syndicate"]);
    expect(batches[1]?.join(" | ")).toContain(
      "The Red Sash — The dockworkers' syndicate that runs the piers.",
    );
    expect(batches[1]?.join(" | ")).toContain(
      "The dockworkers' syndicate — The syndicate of dockworkers controlling the piers.",
    );
  });

  it("a distinct pair the meaning vector also separates is never probed at all", async () => {
    if (!db) throw new Error("unreachable");
    // Every text lands on its own basis vector: nothing is near anything.
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map((_t, i) => basis(i)));
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
    mockProbe.mockImplementation((_s: any, _o: any) =>
      Promise.resolve({ same: true, confidence: 0.99, reason: "should never be asked" } as never),
    );
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "Kaz",
        entityType: "npc",
        block: "A smuggler working the outer belt.",
        turnId: 1,
        ...ENV,
      },
      {
        campaignId,
        name: "Mother Superior",
        entityType: "npc",
        block: "The abbess of the cliffside convent.",
        turnId: 2,
        ...ENV,
      },
    ]);

    const report = await reviewCatalog(db, campaignId, 11, DEV_TIER_SELECTION);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(report.merged).toHaveLength(0);
    expect(report.suggested).toHaveLength(0);
  });
});
