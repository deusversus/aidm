import { getCurrentUser } from "@/lib/auth";
import { PIN_MAX_COUNT } from "@/lib/blocks/assemble";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

/**
 * droppedPins finds its reader (M3R2 C5). `assembleBlocks` has always known
 * which pins the head of memory can actually carry — the ≤5/≤2k bound and the
 * window dedup — and returned the dropped ones to nobody. The surface said
 * "Pinned — held verbatim at the head of memory" either way, which for a
 * dropped pin was simply false. The POST now answers with the truth and the
 * play view's existing one-line notice says it.
 *
 * Route handlers are plain functions: invoked directly with mocked auth
 * against the real dev Postgres (no mocked DB in integration tests).
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[pins-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pinReq = (content: string, sourceTurn: number) =>
  new Request("http://test/pins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, sourceTurn }),
  });

interface PinResponse {
  ok: boolean;
  carried: boolean;
  reason?: "in_window" | "budget";
  wouldExceedBudget?: boolean;
  head?: { count: number; tokens: number };
  limits?: { maxCount: number; maxTokens: number };
}

describe.skipIf(!url)("pins route — the head of memory answers honestly", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "pins@example.com" });
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
    mockUser.mockResolvedValue({ id: playerId, email: "pins@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "pins fixture",
        status: "active",
        premiseContract: bebopContract(),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
  });

  it("a pin inside the bound is CARRIED", async () => {
    // sourceTurn 0 = pre-play/unknown, never withheld by the window dedup.
    const res = await POST(pinReq("Whatever happens, happens.", 0), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PinResponse;
    expect(body.carried).toBe(true);
    expect(body.reason).toBeUndefined();
    // A carried pin is by definition inside the budget.
    expect(body.wouldExceedBudget).toBe(false);
    expect(body.head?.count).toBe(1);
  });

  it("a pin past the count bound is NOT carried, and says which bound (the old lie)", async () => {
    for (let i = 0; i < PIN_MAX_COUNT; i++) {
      const res = await POST(pinReq(`held passage ${i}`, 0), params(campaignId));
      expect(((await res.json()) as PinResponse).carried).toBe(true);
    }
    const res = await POST(pinReq("one passage too many", 0), params(campaignId));
    const body = (await res.json()) as PinResponse;
    expect(body.carried).toBe(false);
    expect(body.reason).toBe("budget");
    expect(body.wouldExceedBudget).toBe(true);
    expect(body.limits?.maxCount).toBe(PIN_MAX_COUNT);
  });

  it("a pin whose source scene is still verbatim is withheld BY DESIGN — a different sentence", async () => {
    // No compaction has happened, so the watermark is 0 and turn 4 is still
    // quoted in full: carrying the pin too would duplicate it (§5.4).
    const res = await POST(pinReq("the line from this very scene", 4), params(campaignId));
    const body = (await res.json()) as PinResponse;
    expect(body.carried).toBe(false);
    expect(body.reason).toBe("in_window");
    // And there IS room for it when the scene compacts — the whole answer.
    expect(body.wouldExceedBudget).toBe(false);
  });

  it("in-window AND over the bound answers BOTH — 'later' was only half of it", async () => {
    // The case the wire exists for: by construction a fresh pin comes from a
    // scene still quoted in Block 3, so `in_window` short-circuits ahead of the
    // bound — and a player whose head is already full heard the optimistic
    // half ("it joins once that scene compacts") with no hint that it would be
    // dropped again the instant it became eligible.
    for (let i = 0; i < PIN_MAX_COUNT; i++) {
      const filled = await POST(pinReq(`held passage ${i}`, 0), params(campaignId));
      expect(((await filled.json()) as PinResponse).carried).toBe(true);
    }
    const res = await POST(pinReq("the line from this very scene", 4), params(campaignId));
    const body = (await res.json()) as PinResponse;
    expect(body.carried).toBe(false);
    // The window is still the reason it is not carried NOW…
    expect(body.reason).toBe("in_window");
    // …and the head has no room for it LATER, which is separate news.
    expect(body.wouldExceedBudget).toBe(true);
    expect(body.head?.count).toBe(PIN_MAX_COUNT);
    expect(body.limits?.maxCount).toBe(PIN_MAX_COUNT);
  });
});
