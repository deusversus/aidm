import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "../route";

/**
 * M2 C5 (plan §C5 "Tests"): the decided capabilities round-trip; everything
 * else is rejected server-side. Route handlers are plain functions — invoked
 * directly with mocked auth against the real dev Postgres (no mocked DB in
 * integration tests, working agreement).
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[settings-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const patchReq = (body: unknown) =>
  new Request("http://test/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!url)("settings route (M2 C5, real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "settings@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      // Campaigns first — the players FK has no cascade (C2 eval's lesson).
      await db.delete(schema.campaigns).where(eq(schema.campaigns.playerId, playerId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockUser.mockResolvedValue({ id: playerId, email: "settings@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "settings fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: {
          narration: "claude-sonnet-5",
          judgment: "claude-haiku-4-5",
          probe: "claude-haiku-4-5",
        },
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
  });

  it("tier change round-trips: DB updated, log carries from/to, handoff note on narration", async () => {
    if (!db) throw new Error("unreachable");
    const res = await PATCH(patchReq({ narration: "claude-opus-4-8" }), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changes: { field: string; from: string; to: string }[];
      note?: string;
    };
    expect(body.changes).toEqual([
      expect.objectContaining({
        field: "tier.narration",
        from: "claude-sonnet-5",
        to: "claude-opus-4-8",
      }),
    ]);
    expect(body.note).toMatch(/studio handoff/);

    const [row] = await db
      .select({ tierModels: schema.campaigns.tierModels, log: schema.campaigns.settingsLog })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect((row?.tierModels as { narration: string }).narration).toBe("claude-opus-4-8");
    expect(row?.log).toHaveLength(1);
  });

  it("affordance change is honored in the contract; no handoff note", async () => {
    if (!db) throw new Error("unreachable");
    const res = await PATCH(patchReq({ suggestion_affordance: "default_on" }), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note?: string };
    expect(body.note).toBeUndefined();
    const [row] = await db
      .select({ pc: schema.campaigns.premiseContract })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect((row?.pc as { suggestion_affordance: string }).suggestion_affordance).toBe("default_on");
  });

  it("every other contract field is rejected server-side (the M4 boundary)", async () => {
    for (const body of [
      { spark: "hacked" },
      { dna: { darkness: 10 } },
      { narration: "gpt-5" },
      { suggestion_affordance: "always" },
      {},
    ]) {
      const res = await PATCH(patchReq(body), params(campaignId));
      expect(res.status).toBe(400);
    }
  });

  it("a requested write that cannot apply answers 422, never a silent 200 (audit #1/#2)", async () => {
    if (!db) throw new Error("unreachable");
    await db
      .update(schema.campaigns)
      .set({ premiseContract: { corrupt: true }, tierModels: { corrupt: true } })
      .where(eq(schema.campaigns.id, campaignId));
    const aff = await PATCH(patchReq({ suggestion_affordance: "never" }), params(campaignId));
    expect(aff.status).toBe(422);
    const tier = await PATCH(patchReq({ judgment: "claude-sonnet-5" }), params(campaignId));
    expect(tier.status).toBe(422);
  });

  it("a no-op patch logs nothing", async () => {
    if (!db) throw new Error("unreachable");
    const res = await PATCH(patchReq({ narration: "claude-sonnet-5" }), params(campaignId));
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ log: schema.campaigns.settingsLog })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(row?.log).toEqual([]);
  });

  it("GET returns tiers, affordance, and the menus; foreign campaigns 404", async () => {
    const res = await GET(new Request("http://test/settings"), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tiers: { narration: string }; menus: unknown };
    expect(body.tiers.narration).toBe("claude-sonnet-5");
    expect(body.menus).toBeTruthy();

    mockUser.mockResolvedValue({ id: "user_someone_else", email: null });
    const foreign = await GET(new Request("http://test/settings"), params(campaignId));
    expect(foreign.status).toBe(404);
  });
});
