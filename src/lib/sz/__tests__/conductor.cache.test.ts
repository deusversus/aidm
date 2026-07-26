import * as schema from "@/lib/db/schema";
import { streamNarration } from "@/lib/llm/calls";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONDUCTOR_SYSTEM, runConductorTurn } from "../conductor";

/**
 * Conductor request shape (M2R5 C2): the breakpoint rides the LAST system
 * block — so a returning player's taste block sits INSIDE the cached prefix
 * instead of re-billing at list price — plus a moving breakpoint on the last
 * transcript message, re-placed every round and every turn. The transcript is
 * append-only, so each request reads the prior request's write; everything
 * behind the mark must stay byte-identical to the durable draft or the prefix
 * is busted and the write bought nothing.
 *
 * streamNarration is scripted (same pattern as the resume suite); the DB is real.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, streamNarration: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sz.cache] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

type ScriptBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function scriptedRound(blocks: ScriptBlock[], stopReason: "end_turn" | "tool_use") {
  return {
    stream: { on: () => {} },
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

const recordRound = (id: string, content: string) =>
  scriptedRound(
    [{ type: "tool_use", id, name: "record_observation", input: { kind: "spark", content } }],
    "tool_use",
  );

/** Every cache_control mark in a message list, with where it sits. */
function marks(messages: MessageParam[]): { message: number; block: number }[] {
  const found: { message: number; block: number }[] = [];
  messages.forEach((m, mi) => {
    if (typeof m.content === "string") return;
    (m.content as ContentBlockParam[]).forEach((b, bi) => {
      if ((b as { cache_control?: unknown }).cache_control) found.push({ message: mi, block: bi });
    });
  });
  return found;
}

function requests(): { system: TextBlockParam[]; messages: MessageParam[] }[] {
  return mockStream.mock.calls.map((c) => ({
    system: c[0].system as TextBlockParam[],
    messages: c[0].messages,
  }));
}

describe.skipIf(!url)("SZ conductor cache breakpoints (real Postgres, scripted model)", () => {
  const returningPlayerId = `test_player_${crypto.randomUUID()}`;
  const newPlayerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(playerId: string): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "cache fixture", status: "draft" })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values([
      {
        id: returningPlayerId,
        email: "cache-returning@example.com",
        profile: { taste: ["loves found-family premises"] },
      },
      { id: newPlayerId, email: "cache-new@example.com" },
    ]);
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      for (const id of campaignIds) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
      }
      await db.delete(schema.players).where(eq(schema.players.id, returningPlayerId));
      await db.delete(schema.players).where(eq(schema.players.id, newPlayerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(() => mockStream.mockReset());

  it("marks the last system block and moves the message mark across rounds and turns", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign(returningPlayerId);

    // Turn 1: three rounds (tool, tool, prose). Turn 2: one round.
    mockStream
      .mockReturnValueOnce(recordRound("tu_1", "the moment before the leap"))
      .mockReturnValueOnce(recordRound("tu_2", "and they go anyway"))
      .mockReturnValueOnce(scriptedRound([{ type: "text", text: "Say more." }], "end_turn"))
      .mockReturnValueOnce(scriptedRound([{ type: "text", text: "Then we play." }], "end_turn"));

    await runConductorTurn(db, campaignId, "let's play cowboy bebop", () => {});
    const draft = await runConductorTurn(db, campaignId, "the rooftop scene", () => {});

    const reqs = requests();
    expect(reqs).toHaveLength(4);

    // --- system: ONE mark, on the LAST block (the taste block, here) --------
    for (const req of reqs) {
      expect(req.system).toHaveLength(2);
      expect(req.system[0]?.text).toBe(CONDUCTOR_SYSTEM);
      // Moved, not duplicated: the persona block no longer carries its own.
      expect(req.system[0]?.cache_control).toBeUndefined();
      expect(req.system[1]?.text).toContain("RETURNING PLAYER");
      expect(req.system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }

    // --- messages: ONE mark, always on the tail block of the tail message ---
    for (const req of reqs) {
      const found = marks(req.messages);
      expect(found).toHaveLength(1);
      const tailMessage = req.messages.length - 1;
      const tailBlocks = req.messages[tailMessage]?.content as ContentBlockParam[];
      expect(found[0]).toEqual({ message: tailMessage, block: tailBlocks.length - 1 });
      expect(tailBlocks[tailBlocks.length - 1]).toMatchObject({
        cache_control: { type: "ephemeral", ttl: "1h" },
      });
    }

    // --- the mark MOVES: the transcript only ever grows behind it -----------
    // round 1 (player line) → round 2 (+assistant, +tool_result) → round 3
    // (+assistant, +tool_result) → turn 2 (+assistant, +player line).
    expect(reqs.map((r) => r.messages.length)).toEqual([1, 3, 5, 7]);

    // --- everything behind the mark is the durable transcript, verbatim -----
    // Byte-stability is the whole bet: one changed byte in the head and the
    // next request writes a new entry instead of reading the last one. Every
    // string renders as a one-block array — one byte shape for a message's
    // whole life, never a marked-array-then-bare-string flip (C2 audit).
    for (const req of reqs) {
      for (let i = 0; i < req.messages.length - 1; i++) {
        const durable = draft.transcript[i]?.content;
        expect(req.messages[i]).toEqual({
          role: draft.transcript[i]?.role,
          content: typeof durable === "string" ? [{ type: "text", text: durable }] : durable,
        });
      }
    }

    // --- the mark is request-shape only; the persisted draft stays clean ----
    expect(JSON.stringify(draft.transcript)).not.toContain("cache_control");
    const [row] = await db
      .select({ szTranscript: schema.campaigns.szTranscript })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(JSON.stringify(row?.szTranscript)).not.toContain("cache_control");
  });

  it("a first-time player's single system block carries the mark", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign(newPlayerId);
    mockStream.mockReturnValueOnce(
      scriptedRound([{ type: "text", text: "Welcome. What are we playing?" }], "end_turn"),
    );

    await runConductorTurn(db, campaignId, "", () => {});

    const [req] = requests();
    expect(req?.system).toHaveLength(1);
    expect(req?.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The kickoff sentinel is a string in the draft; EVERY transcript string
    // renders as a one-block array — one byte shape for a message's whole
    // life, never a marked-array-then-bare-string flip (C2 audit).
    const tail = req?.messages[0]?.content as ContentBlockParam[];
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });
});
