import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { DirectionState } from "@/lib/types/direction";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "../route";

/**
 * The §4.5 M2R3 steering-honesty notice dismiss (once per override). Real
 * Postgres; auth mocked, never the DB (working agreement). The play page reads
 * the flag server-side, so there is no GET — only the dismiss, which clears it.
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[steering-notice-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://test/steering-notice", { method: "DELETE" });

const NOTICE = { axis: "darkness", observed: 8, set: 3, at_turn: 16 };

describe.skipIf(!url)("steering-notice dismiss route (M2R3, real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "steer@example.com" });
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
    mockUser.mockResolvedValue({ id: playerId, email: "steer@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "steering fixture",
        status: "active",
        premiseContract: bebopContract(),
        directionState: { steering_notice: NOTICE },
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
  });

  async function readNotice(): Promise<unknown> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .select({ d: schema.campaigns.directionState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    return DirectionState.parse(row?.d ?? {}).steering_notice;
  }

  it("dismiss clears the notice (once per override — a reload never re-shows it)", async () => {
    expect(await readNotice()).toMatchObject(NOTICE);
    const res = await DELETE(req(), params(campaignId));
    expect(res.status).toBe(200);
    expect(await readNotice()).toBeUndefined();

    // Idempotent: a second dismiss is a clean no-op, still 200.
    const res2 = await DELETE(req(), params(campaignId));
    expect(res2.status).toBe(200);
    expect(await readNotice()).toBeUndefined();
  });

  it("rejects a caller who does not own the campaign (404), leaving the notice", async () => {
    mockUser.mockResolvedValue({ id: "someone_else", email: "nope@example.com" });
    const res = await DELETE(req(), params(campaignId));
    expect(res.status).toBe(404);
    // Restore ownership to observe the notice survived the rejected dismiss.
    mockUser.mockResolvedValue({ id: playerId, email: "steer@example.com" });
    expect(await readNotice()).toMatchObject(NOTICE);
  });

  it("401 for an unauthenticated caller", async () => {
    mockUser.mockResolvedValue(null);
    const res = await DELETE(req(), params(campaignId));
    expect(res.status).toBe(401);
  });
});
