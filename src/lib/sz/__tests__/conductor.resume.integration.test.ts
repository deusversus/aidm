import * as schema from "@/lib/db/schema";
import { streamNarration } from "@/lib/llm/calls";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ConductorDraft, SZ_KICKOFF, draftMessages, runConductorTurn } from "../conductor";

/**
 * Draft-resume round-trip (M1-C3): the transcript + extraction state
 * rehydrate FROM THE DATABASE between turns — each runConductorTurn call
 * simulates a fresh process. streamNarration is scripted; the DB is real.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, streamNarration: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sz.resume] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** One scripted narration round: emits each text block, then resolves. */
function scriptedRound(blocks: ContentBlock[], stopReason: "end_turn" | "tool_use") {
  return {
    stream: {
      on: (event: string, cb: (t: string) => void) => {
        if (event === "text") {
          for (const b of blocks) if (b.type === "text") cb(b.text);
        }
      },
    },
    done: async () => ({
      message: {
        content: blocks,
        stop_reason: stopReason,
        model: "scripted",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      prose: blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join(""),
      sidecar: null,
      fallbackUsed: false,
      refused: false,
      costUsd: 0,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

const mockStream = vi.mocked(streamNarration);

describe.skipIf(!url)("SZ conductor draft-resume (real Postgres, scripted model)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({
      id: playerId,
      email: "resume@example.com",
      profile: { taste: ["loves found-family premises"] },
    });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "Session Zero", status: "draft" })
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

  it("turn 1: kickoff persists transcript, observations, and the §6.9 greeting context", async () => {
    if (!db) throw new Error("unreachable");
    mockStream
      .mockReturnValueOnce(
        scriptedRound(
          [
            { type: "text", text: "Welcome back. " },
            {
              type: "tool_use",
              id: "tu_1",
              name: "record_observation",
              input: { kind: "player_taste", content: "returning player, greeted warmly" },
            },
          ],
          "tool_use",
        ),
      )
      .mockReturnValueOnce(
        scriptedRound([{ type: "text", text: "So — what are we playing?" }], "end_turn"),
      );

    const texts: string[] = [];
    const draft = await runConductorTurn(db, campaignId, "", (e) => {
      if (e.type === "text" && e.text) texts.push(e.text);
    });

    expect(texts.join("")).toContain("what are we playing");
    expect(draft.observations).toHaveLength(1);
    // Kickoff sentinel + assistant(tool) + tool_result + assistant(final).
    expect(draft.transcript).toHaveLength(4);
    expect(draft.transcript[0]?.content).toBe(SZ_KICKOFF);

    // The §6.9 returning-player block rode along in the system array.
    const call = mockStream.mock.calls[0]?.[0];
    expect(call?.system.some((b) => b.text.includes("found-family"))).toBe(true);

    // Persisted, not just in memory.
    const [row] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect((row?.szTranscript as ConductorDraft).transcript).toHaveLength(4);
    expect(row?.szExtraction).toHaveLength(1);
  });

  it("turn 2 resumes from the DB: full history reaches the model, conversation continues", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    mockStream.mockReturnValueOnce(
      scriptedRound(
        [{ type: "text", text: "Bebop it is. Tell me a moment you want more of." }],
        "end_turn",
      ),
    );

    // A fresh call — state must come from Postgres, not from turn 1's closure.
    const draft = await runConductorTurn(db, campaignId, "let's play cowboy bebop", () => {});

    const sent = mockStream.mock.calls[0]?.[0];
    expect(sent?.messages).toHaveLength(5); // turn 1's four + the new player message
    expect(sent?.messages[0]?.content).toBe(SZ_KICKOFF);
    expect(sent?.messages[4]?.content).toBe("let's play cowboy bebop");
    // Tool round-trips survive rehydration in order (API replay requirement).
    const blocks = sent?.messages[1]?.content as { type: string }[];
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);

    expect(draft.transcript).toHaveLength(6);
    // Extraction state rehydrates too: turn 1's observation came from the DB,
    // not this turn's memory, and survives the round-trip.
    expect(draft.observations).toHaveLength(1);
    expect(draft.observations[0]?.content).toContain("returning player");
    const [row] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(row?.szExtraction).toHaveLength(1);
    const shown = draftMessages(draft);
    expect(shown.some((m) => m.role === "player" && m.text.includes("cowboy bebop"))).toBe(true);
    expect(shown.some((m) => m.text === SZ_KICKOFF)).toBe(false);
  });
});
