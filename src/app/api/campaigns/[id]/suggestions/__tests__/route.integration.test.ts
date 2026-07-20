import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { callProbe } from "@/lib/llm/calls";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

/**
 * M2R R1 (§9.2): the summon serves the KA's PERSISTED moves before paying
 * for a fresh probe, and "never" is honored server-side. Real Postgres;
 * auth and the probe boundary mocked (never the DB).
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...orig, callProbe: vi.fn() };
});
const mockProbe = vi.mocked(callProbe);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[suggestions-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://test/suggestions", { method: "POST" });

describe.skipIf(!url)("suggestions route (M2R R1, real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "moves@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.playerId, playerId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockUser.mockResolvedValue({ id: playerId, email: "moves@example.com" });
    mockProbe.mockReset();
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "suggestions fixture",
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

  it("serves the latest turn's persisted sidecar moves WITHOUT a probe call", async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockRejectedValue(new Error("probe must not fire when persisted moves exist"));
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 1,
      tier: "genga",
      status: "complete",
      playerInput: "look around",
      sidecar: {
        decision_point: false,
        suggested_moves: ["Press him about the rope", "Walk the aquifer line"],
        notable_beats: ["the well hums"],
      },
    });
    const res = await POST(req(), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { moves: string[] };
    expect(body.moves).toEqual(["Press him about the rope", "Walk the aquifer line"]);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("falls back to the probe when the latest turn carries no moves", async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockResolvedValue({ moves: ["Chase the shuttle", "Tail the money"] } as never);
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 1,
      tier: "douga",
      status: "complete",
      playerInput: "wait",
      sidecar: { decision_point: false, notable_beats: ["quiet beat"] },
    });
    const res = await POST(req(), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { moves: string[] };
    expect(body.moves).toEqual(["Chase the shuttle", "Tail the money"]);
    expect(mockProbe).toHaveBeenCalledOnce();
  });

  it('"never" is honored server-side: 403, no probe, no moves', async () => {
    if (!db) throw new Error("unreachable");
    await db
      .update(schema.campaigns)
      .set({ premiseContract: { ...bebopContract(), suggestion_affordance: "never" } })
      .where(eq(schema.campaigns.id, campaignId));
    const res = await POST(req(), params(campaignId));
    expect(res.status).toBe(403);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("an in-flight turn still owns the scene: 409 before any reuse", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 1,
      tier: "genga",
      status: "queued",
      playerInput: "act",
    });
    const res = await POST(req(), params(campaignId));
    expect(res.status).toBe(409);
  });
});
