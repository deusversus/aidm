import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { synthesize } from "@/lib/tts/elevenlabs";
import { speechSegments } from "@/lib/tts/speech-text";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

/**
 * §9.5 segmented listen path (2026-07-20): the route now serves a turn's
 * narration as indexed segments, plus a synthesis-free `?meta=1` count probe.
 * Route handlers are plain functions — invoked directly with mocked auth and a
 * stubbed ElevenLabs boundary against the real dev Postgres (no mocked DB in
 * integration tests, working agreement).
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

// The ElevenLabs HTTP boundary is stubbed (like auth); the DB stays real.
vi.mock("@/lib/tts/elevenlabs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/tts/elevenlabs")>();
  return { ...orig, ttsConfigured: () => true, synthesize: vi.fn() };
});
const mockSynthesize = vi.mocked(synthesize);

const audioResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
        c.close();
      },
    }),
    { headers: { "Content-Type": "audio/mpeg" } },
  );

const url = process.env.DATABASE_URL;
if (!url) console.warn("[tts-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// A multi-segment narration: clean sentences, comfortably over one segment.
const NARRATION = "The pulse went on and the lamp kept its slow tick over the quiet dock. ".repeat(
  60,
);

async function usageRows(campaignId: string) {
  if (!db) throw new Error("unreachable");
  return db.select().from(schema.modelCalls).where(eq(schema.modelCalls.campaignId, campaignId));
}

describe.skipIf(!url)("tts route — segmented listen (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "tts@example.com" });
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
    mockSynthesize.mockReset();
    mockUser.mockResolvedValue({ id: playerId, email: "tts@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "tts fixture",
        status: "active",
        premiseContract: bebopContract(),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 1,
      tier: "genga",
      status: "complete",
      playerInput: "look around",
      narration: NARRATION,
    });
  });

  it("?meta=1 returns the segment count without synthesizing or metering", async () => {
    const expected = speechSegments(NARRATION).length;
    expect(expected).toBeGreaterThan(1); // the fixture is genuinely multi-segment

    const res = await GET(new Request("http://test/tts?turn=1&meta=1&v=abc"), params(campaignId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { segments: number };
    expect(body.segments).toBe(expected);
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(await usageRows(campaignId)).toHaveLength(0);
  });

  it("negative and non-integer seg are 400 too, never a crash", async () => {
    for (const bad of ["-1", "1.5", "NaN"]) {
      const res = await GET(new Request(`http://test/tts?turn=1&seg=${bad}`), params(campaignId));
      expect(res.status).toBe(400);
    }
  });

  it("a seg index past the count is 400, never synthesized", async () => {
    const res = await GET(new Request("http://test/tts?turn=1&seg=9999&v=abc"), params(campaignId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("segment out of range");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("seg=0 synthesizes that segment's text and stamps the segment headers", async () => {
    mockSynthesize.mockResolvedValue(audioResponse());
    const segments = speechSegments(NARRATION);

    const res = await GET(new Request("http://test/tts?turn=1&seg=0&v=abc"), params(campaignId));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Segment-Count")).toBe(String(segments.length));
    expect(res.headers.get("X-Segment-Index")).toBe("0");
    // Drain the instrumented stream so its byte counter completes.
    expect((await res.arrayBuffer()).byteLength).toBe(4);

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize.mock.calls[0]?.[0]).toBe(segments[0]);

    // The usage row is fire-and-forget — poll briefly for it.
    let rows = await usageRows(campaignId);
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await usageRows(campaignId);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("elevenlabs");
    expect(rows[0]?.inputTokens).toBe(segments[0]?.length);
  });

  it("defaults to seg 0 when the index is omitted", async () => {
    mockSynthesize.mockResolvedValue(audioResponse());
    const res = await GET(new Request("http://test/tts?turn=1&v=abc"), params(campaignId));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Segment-Index")).toBe("0");
    await res.arrayBuffer();
  });

  it("a foreign campaign is 404 before any segmentation", async () => {
    mockUser.mockResolvedValue({ id: "user_someone_else", email: null });
    const res = await GET(new Request("http://test/tts?turn=1&meta=1&v=abc"), params(campaignId));
    expect(res.status).toBe(404);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });
});
