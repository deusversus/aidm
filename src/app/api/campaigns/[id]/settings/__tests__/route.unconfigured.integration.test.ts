import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "../route";

/**
 * The TTS-off half of the voice surface (separate file because vi.mock is
 * module-scoped): with no ElevenLabs key, GET must omit the voice keys
 * entirely and a voice patch must answer a loud 422 — never a half-rendered
 * picker, never a silent 200.
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

vi.mock("@/lib/tts/elevenlabs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/tts/elevenlabs")>();
  return { ...orig, ttsConfigured: () => false };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[settings-route-unconfigured] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!url)("settings route with TTS unconfigured (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "novoice@example.com" });
    mockUser.mockResolvedValue({ id: playerId, email: "novoice@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "unconfigured fixture",
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

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.playerId, playerId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("GET omits the voice keys entirely", async () => {
    const res = await GET(new Request("http://test/settings"), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("voices");
    expect(body).not.toHaveProperty("voice_source");
    expect(body).not.toHaveProperty("voice_id");
  });

  it("a voice patch answers 422, never a silent 200", async () => {
    if (!db) throw new Error("unreachable");
    const res = await PATCH(
      new Request("http://test/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: "21m00Tcm4TlvDq8ikWAM" }),
      }),
      params(campaignId),
    );
    expect(res.status).toBe(422);
    const [row] = await db
      .select({ vs: schema.campaigns.voiceSettings })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(row?.vs).toBeNull();
  });
});
