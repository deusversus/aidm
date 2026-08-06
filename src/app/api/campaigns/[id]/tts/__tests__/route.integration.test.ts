import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { PREVIEW_LINE, availableVoices, synthesize } from "@/lib/tts/elevenlabs";
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
// `availableVoices` is stubbed too — the real one lists the account's library
// over the network, and no test may reach ElevenLabs.
vi.mock("@/lib/tts/elevenlabs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/tts/elevenlabs")>();
  return {
    ...orig,
    ttsConfigured: () => true,
    synthesize: vi.fn(),
    availableVoices: vi.fn(),
  };
});
const mockSynthesize = vi.mocked(synthesize);
const mockVoices = vi.mocked(availableVoices);

/** An upstream body delivered in `chunks` pieces — the overcount's shape. */
const chunkedAudio = (chunks: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array([1, 2, 3, 4]));
        c.close();
      },
    }),
    { headers: { "Content-Type": "audio/mpeg" } },
  );

const audioResponse = () => chunkedAudio(1);

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

/**
 * Poll for `expected` usage rows, then wait past that point so a row the route
 * should NOT have written still has time to appear — the ledger claim under
 * test is "exactly this many", not "at least".
 */
async function settledRows(campaignId: string, expected: number, graceMs = 400) {
  let rows = await usageRows(campaignId);
  for (let i = 0; i < 40 && rows.length < expected; i++) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await usageRows(campaignId);
  }
  await new Promise((r) => setTimeout(r, graceMs));
  return usageRows(campaignId);
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
    mockVoices.mockReset();
    mockVoices.mockResolvedValue({
      voices: [{ voice_id: "voice_fixture", name: "Fixture", hint: "test" }],
      source: "curated",
    });
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

  // --- The ledger: one row per COMPLETED synthesis (M3R4 B3) -----------------
  // The 2026-08-06 calibration: 359,927 recorded characters against a dashboard
  // that measured 53.9K. The route metered the REQUEST — headers arrived, row
  // written, delivery irrelevant — so every abandoned prefetch billed the
  // ledger for a full segment it never converted.

  it("a segment streamed in MANY chunks writes exactly ONE row, chars = the segment text", async () => {
    mockSynthesize.mockImplementation(() => Promise.resolve(chunkedAudio(12)));
    const segments = speechSegments(NARRATION);

    const res = await GET(new Request("http://test/tts?turn=1&seg=0&v=abc"), params(campaignId));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(48); // 12 chunks × 4 bytes

    const rows = await settledRows(campaignId, 1);
    expect(rows).toHaveLength(1);
    // Not 12×, and not the whole narration — this one segment's own characters.
    expect(rows[0]?.inputTokens).toBe(segments[0]?.length);
    expect(rows[0]?.inputTokens).toBeLessThan(NARRATION.length);
    expect(rows[0]?.phase).toBe("tts");
  });

  it("a listener who walks away mid-stream writes NO row — an abandoned prefetch is not spend we can claim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSynthesize.mockImplementation(() => Promise.resolve(chunkedAudio(20)));

    const res = await GET(new Request("http://test/tts?turn=1&seg=0&v=abc"), params(campaignId));
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    await reader.read(); // one chunk delivered…
    await reader.cancel("navigated away"); // …then the element is discarded

    expect(await settledRows(campaignId, 0)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[tts] synthesis abandoned — no ledger row",
      expect.objectContaining({ why: "client cancelled" }),
    );
    warn.mockRestore();
  });

  it("an upstream that breaks mid-transfer writes NO row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSynthesize.mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array([1, 2, 3, 4]));
              c.error(new Error("upstream died"));
            },
          }),
          { headers: { "Content-Type": "audio/mpeg" } },
        ),
      ),
    );

    const res = await GET(new Request("http://test/tts?turn=1&seg=0&v=abc"), params(campaignId));
    await expect(res.arrayBuffer()).rejects.toThrow();

    expect(await settledRows(campaignId, 0)).toHaveLength(0);
    warn.mockRestore();
  });

  it("a RE-request re-synthesizes and earns its own row — a retry is real spend, never deduped", async () => {
    mockSynthesize.mockImplementation(() => Promise.resolve(chunkedAudio(2)));
    for (let i = 0; i < 2; i++) {
      const res = await GET(new Request("http://test/tts?turn=1&seg=0&v=abc"), params(campaignId));
      await res.arrayBuffer();
    }

    expect(mockSynthesize).toHaveBeenCalledTimes(2);
    const rows = await settledRows(campaignId, 2);
    expect(rows).toHaveLength(2);
    const segments = speechSegments(NARRATION);
    for (const r of rows) expect(r.inputTokens).toBe(segments[0]?.length);
  });

  it("a preview clicked through and abandoned writes NO row either — the voice menu is the worst offender", async () => {
    // The segment path has this pin; the preview path did not (B3 audit nit).
    // Clicking down a voice list is exactly the abandon-heavy pattern that
    // produced the 6.7× overcount, so its ledger claim needs its own test.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSynthesize.mockImplementation(() => Promise.resolve(chunkedAudio(20)));

    const res = await GET(new Request("http://test/tts?preview=voice_fixture"), params(campaignId));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    await reader.read(); // one chunk auditioned…
    await reader.cancel("next voice"); // …then the next voice is clicked

    expect(await settledRows(campaignId, 0)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[tts] synthesis abandoned — no ledger row",
      expect.objectContaining({ why: "client cancelled", chars: PREVIEW_LINE.length }),
    );
    warn.mockRestore();
  });

  it("the voice preview is metered on completion too, at the preview line's length", async () => {
    mockSynthesize.mockImplementation(() => Promise.resolve(chunkedAudio(4)));

    const res = await GET(new Request("http://test/tts?preview=voice_fixture"), params(campaignId));
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const rows = await settledRows(campaignId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(PREVIEW_LINE.length);
    expect(rows[0]?.turnNumber).toBeNull();
  });
});
