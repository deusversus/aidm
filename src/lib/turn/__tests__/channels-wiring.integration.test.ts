import { closeBoothIfOpen, mintOverride, runBoothExchange } from "@/lib/booth/booth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { ingestAssertion } from "@/lib/ingestion/ingest";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { type TurnEvent, attachToTurn, submitTurn } from "@/lib/turn/runtime";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C9 channel WIRING (the integrator's seams, §5.4): the runtime dispatches
 * META_FEEDBACK to the booth (reply streams as prose; terminal channel event
 * carries responder/closed; replay metadata on the sidecar), OVERRIDE/OP
 * commands to the override channel (acknowledgement), emits the assertion
 * event on WORLD_BUILDING story turns, and closes an open booth when the
 * fiction resumes. Booth/ingestion are mocked — their own suites cover them;
 * this suite proves the dispatch. Real Postgres; never a live model call.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn(), streamNarration: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});
vi.mock("@/lib/booth/booth", () => ({
  runBoothExchange: vi.fn(),
  mintOverride: vi.fn(),
  closeBoothIfOpen: vi.fn(async () => {}),
}));
vi.mock("@/lib/ingestion/ingest", () => ({
  ingestAssertion: vi.fn(async () => ({ writes: [], flags: [] })),
}));
vi.mock("@/lib/turn/rewind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/turn/rewind")>();
  return { ...actual, writeSnapshotIfDue: vi.fn(async () => {}) };
});

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockEmbed = vi.mocked(embedTexts);
const mockBooth = vi.mocked(runBoothExchange);
const mockMint = vi.mocked(mintOverride);
const mockClose = vi.mocked(closeBoothIfOpen);
const mockIngest = vi.mocked(ingestAssertion);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[channels-wiring] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};
const VEC = () => Array.from({ length: 1024 }, (_, i) => ((i % 7) + 1) * 0.001);

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function kaRound(blocks: Block[], stopReason: "end_turn" | "tool_use") {
  return {
    stream: {
      on: (event: string, cb: (t: string) => void) => {
        if (event === "text") for (const b of blocks) if (b.type === "text") cb(b.text);
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

/** Scripts the full story-turn model surface (intent → pacer → outcome → KA → distiller). */
function armStoryModels(intent: string) {
  mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "intent_triage")
      return Promise.resolve({
        intent,
        action: "act",
        epicness: 0.3,
        special_conditions: [],
        confidence: 0.9,
      }) as never;
    if (opts.name === "pacer_micro")
      return Promise.resolve({
        beat_classification: "quiet",
        strength: "suggestion",
        must_reference: [],
        avoid: [],
      }) as never;
    return Promise.reject(new Error(`unscripted probe ${opts.name}`)) as never;
  });
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockJudgment.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "outcome_judgment")
      return Promise.resolve({
        success_level: "success",
        difficulty_class: 10,
        modifiers: [],
        narrative_weight: "MINOR",
        rationale: "scripted",
      }) as never;
    if (opts.name === "relevance_filter") return Promise.resolve({ scores: [] }) as never;
    if (opts.name === "g2_distill")
      return Promise.resolve({
        narrated_fragment: "f",
        facts: [],
        entity_updates: [],
        confirmed_seed_descriptions: [],
        meta_comments: [],
      }) as never;
    return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
  });
  mockStream.mockImplementation(() =>
    kaRound(
      [
        { type: "text", text: "The scene lands. " },
        {
          type: "tool_use",
          id: "t1",
          name: "commit_scene",
          input: { decision_point: false, notable_beats: ["x"], scene_cast_delta: [] },
        },
      ],
      "tool_use",
    ),
  );
}

async function collectTurn(
  db2: NonNullable<typeof db>,
  campaignId: string,
  input: string,
): Promise<{ events: TurnEvent[]; turnId: string }> {
  const { turnId } = await submitTurn(db2, campaignId, input);
  const events: TurnEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn hung")), 20_000);
    attachToTurn(turnId, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "error" || e.type === "channel") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { events, turnId };
}

describe.skipIf(!url)("C9 channel wiring (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "channels fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "channels@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    for (const id of campaignIds) {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
    }
    await db.delete(schema.players).where(eq(schema.players.id, playerId));
    await pool.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(undefined);
  });

  it("META_FEEDBACK dispatches to the booth: reply streams as prose, terminal event + sidecar carry responder/closed", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("META_FEEDBACK");
    mockBooth.mockImplementation(async (_db, _cid, _turn, _input, emit) => {
      emit("The pen hears you. ");
      emit("Let's talk pacing.");
      return { reply: "The pen hears you. Let's talk pacing.", responder: "ka", closed: false };
    });

    const { events, turnId } = await collectTurn(db, campaignId, "meta: the prose feels rushed");

    const prose = events
      .filter((e): e is Extract<TurnEvent, { type: "prose" }> => e.type === "prose")
      .map((e) => e.text)
      .join("");
    expect(prose).toBe("The pen hears you. Let's talk pacing.");
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "channel",
      intent: "META_FEEDBACK",
      responder: "ka",
      closed: false,
    });
    expect(mockBooth).toHaveBeenCalledTimes(1);
    expect(mockMint).not.toHaveBeenCalled();

    const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(row?.status).toBe("channel");
    expect(row?.narration).toBe("The pen hears you. Let's talk pacing.");
    expect(row?.sidecar).toMatchObject({
      channel: "META_FEEDBACK",
      responder: "ka",
      closed: false,
    });
  });

  it("OVERRIDE_COMMAND mints an override with minimal ceremony (§7.4)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("OVERRIDE_COMMAND");
    mockMint.mockResolvedValue({ acknowledgement: "Standing rule recorded." });

    const { events, turnId } = await collectTurn(db, campaignId, "override: never harm the dog");

    expect(mockMint).toHaveBeenCalledWith(
      expect.anything(),
      campaignId,
      1,
      "override: never harm the dog",
    );
    expect(mockBooth).not.toHaveBeenCalled();
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "channel",
      intent: "OVERRIDE_COMMAND",
      acknowledgement: "Standing rule recorded.",
    });
    const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(row?.status).toBe("channel");
    expect(row?.sidecar).toMatchObject({ acknowledgement: "Standing rule recorded." });
  });

  it("a channel responder failure still lands the turn with an apologetic acknowledgement", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("META_FEEDBACK");
    mockBooth.mockRejectedValue(new Error("router exploded"));

    const { events, turnId } = await collectTurn(db, campaignId, "meta: hello?");

    const terminal = events.at(-1) as Extract<TurnEvent, { type: "channel" }>;
    expect(terminal.type).toBe("channel");
    expect(terminal.acknowledgement).toContain("say it again");
    const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(row?.status).toBe("channel"); // terminal, never wedged
  });

  it(
    "a WORLD_BUILDING story turn emits the assertion event and closes an open booth",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      armStoryModels("WORLD_BUILDING");
      mockIngest.mockResolvedValue({
        writes: [{ kind: "entity_created", id: "e1", summary: 'Created location "Blue Crow bar"' }],
        clarify: "is the bar on Mars or Ganymede?",
        flags: ["the bar contradicts nothing — noted for texture"],
      });

      const { events } = await collectTurn(db, campaignId, "There's a bar called the Blue Crow.");

      const assertion = events.find(
        (e): e is Extract<TurnEvent, { type: "assertion" }> => e.type === "assertion",
      );
      expect(assertion).toBeDefined();
      expect(assertion?.writes).toEqual(['Created location "Blue Crow bar"']);
      expect(assertion?.clarify).toBe("is the bar on Mars or Ganymede?");
      expect(assertion?.flags).toEqual(["the bar contradicts nothing — noted for texture"]);
      // Returning to the fiction closes an open booth (§5.4).
      expect(mockClose).toHaveBeenCalledWith(expect.anything(), campaignId, 1);

      await settleG2IfPending(db, campaignId); // drain the detached G2 before cleanup
    },
  );
});
