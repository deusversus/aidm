import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { DEFAULT_THEME, themeFromProfile } from "@/lib/theme";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "../route";

/**
 * M3R4 B5: the reading theme round-trips player-scoped, the enum is enforced
 * server-side, and the write is an atomic jsonb_set that leaves the rest of the
 * profile (taste notes) alone. Route handlers are plain functions — invoked
 * directly with mocked auth against the real dev Postgres (working agreement:
 * no mocked DB in integration tests).
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[theme-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const patchReq = (body: unknown) =>
  new Request("http://test/player/theme", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const profileOf = async (playerId: string) => {
  if (!db) throw new Error("unreachable");
  const [row] = await db
    .select({ profile: schema.players.profile })
    .from(schema.players)
    .where(eq(schema.players.id, playerId));
  return row?.profile as Record<string, unknown> | undefined;
};

describe("themeFromProfile (pure)", () => {
  it("absent, junk, and unreadable profiles all read as the default", () => {
    expect(DEFAULT_THEME).toBe("dark");
    for (const p of [null, undefined, {}, { theme: "chartreuse" }, { theme: 7 }, "not-an-object"]) {
      expect(themeFromProfile(p)).toBe("dark");
    }
    expect(themeFromProfile({ theme: "light" })).toBe("light");
    expect(themeFromProfile({ theme: "dark", taste: ["x"] })).toBe("dark");
  });
});

describe.skipIf(!url)("player theme route (M3R4 B5, real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "theme@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockUser.mockResolvedValue({ id: playerId, email: "theme@example.com" });
    await db
      .update(schema.players)
      .set({ profile: { taste: ["likes a slow burn"] } })
      .where(eq(schema.players.id, playerId));
  });

  it("a theme write round-trips into players.profile and answers with the record", async () => {
    const res = await PATCH(patchReq({ theme: "light" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, theme: "light" });
    expect(await profileOf(playerId)).toEqual({ theme: "light", taste: ["likes a slow burn"] });

    const back = await PATCH(patchReq({ theme: "dark" }));
    expect(back.status).toBe(200);
    expect((await profileOf(playerId))?.theme).toBe("dark");
  });

  it("junk is rejected server-side and nothing is written", async () => {
    for (const body of [
      { theme: "chartreuse" },
      { theme: "DARK" },
      { theme: 1 },
      { theme: "light", taste: ["injected"] },
      { taste: ["injected"] },
      {},
      "not-json-object",
    ]) {
      const res = await PATCH(patchReq(body));
      expect(res.status).toBe(400);
    }
    expect(await profileOf(playerId)).toEqual({ taste: ["likes a slow burn"] });
  });

  it("GET reads the player's own theme; the default when unset", async () => {
    const unset = await GET();
    expect(unset.status).toBe(200);
    expect(await unset.json()).toEqual({ theme: "dark" });

    await PATCH(patchReq({ theme: "light" }));
    const set = await GET();
    expect(await set.json()).toEqual({ theme: "light" });
  });

  it("signed out is 401 on both verbs — never a silent default write", async () => {
    mockUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PATCH(patchReq({ theme: "light" }))).status).toBe(401);
    expect(await profileOf(playerId)).toEqual({ taste: ["likes a slow burn"] });
  });

  it("a player whose row predates the Clerk webhook still gets the write", async () => {
    if (!db) throw new Error("unreachable");
    const fresh = `test_player_${crypto.randomUUID()}`;
    mockUser.mockResolvedValue({ id: fresh, email: "fresh@example.com" });
    try {
      const res = await PATCH(patchReq({ theme: "light" }));
      expect(res.status).toBe(200);
      expect((await profileOf(fresh))?.theme).toBe("light");
    } finally {
      await db.delete(schema.players).where(eq(schema.players.id, fresh));
    }
  });
});
