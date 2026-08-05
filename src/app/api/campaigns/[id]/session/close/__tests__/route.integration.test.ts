import { getCurrentUser } from "@/lib/auth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { closeSession } from "@/lib/direction/session";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

/**
 * §5.8 catch-up-before-reader at the CLOSE boundary (M3R2 C5). Every close
 * artifact reads what G2 writes — the memo reads narrated fragments, seed
 * state and spotlight debt; the Sakkan samples the record; the janitor reads
 * the catalog. The open and rewind routes have always drained first; the close
 * did not, so a sitting ended while the last turn's G2 lagged froze a
 * half-written record into the Learned layer.
 *
 * Order is the whole assertion, so both collaborators are mocked and their
 * calls recorded in sequence; the campaign row is real.
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/compositor/g2", () => ({ settleG2IfPending: vi.fn() }));
vi.mock("@/lib/direction/session", () => ({ closeSession: vi.fn() }));

const mockUser = vi.mocked(getCurrentUser);
const mockDrain = vi.mocked(settleG2IfPending);
const mockClose = vi.mocked(closeSession);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[close-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const closeReq = () =>
  new Request("http://test/session/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "explicit" }),
  });

describe.skipIf(!url)("session close route — G2 drains first", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "close@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "close fixture",
        status: "active",
        premiseContract: bebopContract(),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.mockResolvedValue({ id: playerId, email: "close@example.com" });
  });

  it("drains the lagging write group BEFORE composing the close artifacts", async () => {
    const order: string[] = [];
    mockDrain.mockImplementation(async () => {
      order.push("drain");
    });
    mockClose.mockImplementation(async () => {
      order.push("close");
      return { yokoku: "Next time: the debt comes due." };
    });

    const res = await POST(closeReq(), params(campaignId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ yokoku: "Next time: the debt comes due." });
    expect(order).toEqual(["drain", "close"]);
    expect(mockDrain).toHaveBeenCalledWith(expect.anything(), campaignId);
  });
});
