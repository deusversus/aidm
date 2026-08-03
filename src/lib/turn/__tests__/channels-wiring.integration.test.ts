import {
  closeBoothIfOpen,
  comprehendOverride,
  mintOverride,
  runBoothExchange,
} from "@/lib/booth/booth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { ingestAssertion } from "@/lib/ingestion/ingest";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { type TurnEvent, attachToTurn, executeTurn, submitTurn } from "@/lib/turn/runtime";
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
  comprehendOverride: vi.fn(),
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
const mockComprehend = vi.mocked(comprehendOverride);
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

  it("OVERRIDE_COMMAND comprehends, then mints the RESTATEMENT with minimal ceremony (§7.4, M3R1)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("OVERRIDE_COMMAND");
    mockComprehend.mockResolvedValue({
      contains_standing_rule: true,
      rule: "Never harm the dog.",
      scope: "standing",
    });
    mockMint.mockResolvedValue({ acknowledgement: "Standing rule recorded." });

    const { events, turnId } = await collectTurn(db, campaignId, "override: never harm the dog");

    // The mint carries the studio's restatement, never the raw bytes.
    expect(mockComprehend).toHaveBeenCalledTimes(1);
    expect(mockMint).toHaveBeenCalledWith(expect.anything(), campaignId, 1, "Never harm the dog.");
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
    // The verdict is CHECKPOINTED with the classification (§5.7): a crash
    // between them and the mint must never re-comprehend.
    expect(row?.checkpoints).toMatchObject({
      channel_intent: "OVERRIDE_COMMAND",
      override_verdict: { contains_standing_rule: true, rule: "Never harm the dog." },
    });
  });

  it("OP_COMMAND still mints the raw input — comprehension is the override channel's alone (M3R1 scope)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("OP_COMMAND");
    mockMint.mockResolvedValue({ acknowledgement: "Done." });

    await collectTurn(db, campaignId, "set my HP to full");

    expect(mockComprehend).not.toHaveBeenCalled();
    expect(mockMint).toHaveBeenCalledWith(expect.anything(), campaignId, 1, "set my HP to full");
  });

  it(
    "the bounce floor: no standing rule found → the turn plays as the scene it was (M3R1)",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      // The probe misroutes a story action to OVERRIDE_COMMAND (the eaten-reply
      // incident); comprehension is the second instrument that catches it.
      armStoryModels("OVERRIDE_COMMAND");
      mockComprehend.mockResolvedValue({
        contains_standing_rule: false,
        rule: "",
        scope: "standing",
      });

      const { events, turnId } = await collectTurn(
        db,
        campaignId,
        "Refuse the appeal flatly and let the entry stand.",
      );

      // The scene ran: story terminal, no mint, nothing entered the ledger.
      expect(mockComprehend).toHaveBeenCalledTimes(1);
      expect(mockMint).not.toHaveBeenCalled();
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({ type: "done", turnNumber: 1 });
      const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
      expect(row?.status).toBe("complete");
      expect((row?.narration ?? "").length).toBeGreaterThan(0);
      expect(row?.checkpoints).toMatchObject({ override_bounced: true, phase_a: true });
      const minted = await db
        .select({ id: schema.overrides.id })
        .from(schema.overrides)
        .where(eq(schema.overrides.campaignId, campaignId));
      expect(minted).toHaveLength(0);
      await settleG2IfPending(db, campaignId);
    },
  );

  it("a one_shot verdict still MINTS its restatement — never dice on a request (M3R1 walk-back)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    armStoryModels("OVERRIDE_COMMAND");
    mockComprehend.mockResolvedValue({
      contains_standing_rule: true,
      rule: "Keep this scene short.",
      scope: "one_shot",
    });
    mockMint.mockResolvedValue({ acknowledgement: "Standing rule recorded." });

    const { events } = await collectTurn(db, campaignId, "keep this next scene short please");

    expect(mockMint).toHaveBeenCalledWith(
      expect.anything(),
      campaignId,
      1,
      "Keep this scene short.",
    );
    expect(events.at(-1)).toMatchObject({ type: "channel", intent: "OVERRIDE_COMMAND" });
  });

  it("override crash-replay mints from the CHECKPOINTED verdict — no re-comprehension (§5.7, M3R1)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const [row] = await db
      .insert(schema.turns)
      .values({
        campaignId,
        turnNumber: 1,
        tier: "genga",
        status: "queued",
        playerInput: "override: never harm the dog",
        checkpoints: {
          channel_intent: "OVERRIDE_COMMAND",
          override_verdict: {
            contains_standing_rule: true,
            rule: "Never harm the dog.",
            scope: "standing",
          },
        },
      })
      .returning({ id: schema.turns.id });
    if (!row) throw new Error("turn insert failed");
    mockMint.mockResolvedValue({ acknowledgement: "Standing rule recorded." });

    await executeTurn(db, row.id);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockComprehend).not.toHaveBeenCalled();
    expect(mockMint).toHaveBeenCalledWith(expect.anything(), campaignId, 1, "Never harm the dog.");
    const [after] = await db.select().from(schema.turns).where(eq(schema.turns.id, row.id));
    expect(after?.status).toBe("channel");
  });

  it(
    "bounce crash-replay re-enters the story path directly — never a re-audition at the channel gate (§5.7, M3R1)",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const [row] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber: 1,
          tier: "genga",
          status: "queued",
          playerInput: "Refuse the appeal flatly and let the entry stand.",
          checkpoints: { override_bounced: true },
        })
        .returning({ id: schema.turns.id });
      if (!row) throw new Error("turn insert failed");
      // The probe still classifies OVERRIDE on replay — forceStory must win.
      armStoryModels("OVERRIDE_COMMAND");

      await executeTurn(db, row.id);

      expect(mockComprehend).not.toHaveBeenCalled();
      expect(mockMint).not.toHaveBeenCalled();
      const [after] = await db.select().from(schema.turns).where(eq(schema.turns.id, row.id));
      expect(after?.status).toBe("complete");
      await settleG2IfPending(db, campaignId);
    },
  );

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

  it("channel crash-replay dispatches from the checkpoint WITHOUT re-triaging (§5.7)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    // A channel turn that classified, then crashed before its terminal write:
    // status still queued, the classification checkpointed.
    const [row] = await db
      .insert(schema.turns)
      .values({
        campaignId,
        turnNumber: 1,
        tier: "genga",
        status: "queued",
        playerInput: "meta: hello again",
        checkpoints: { channel_intent: "META_FEEDBACK" },
      })
      .returning({ id: schema.turns.id });
    if (!row) throw new Error("turn insert failed");
    mockBooth.mockImplementation(async (_db, _cid, _turn, _input, emit) => {
      emit("replayed reply");
      return { reply: "replayed reply", responder: "director", closed: false };
    });

    const events: TurnEvent[] = [];
    const detach = attachToTurn(row.id, (e) => events.push(e));
    await executeTurn(db, row.id);
    detach();

    // The stashed classification skipped Layout entirely: no intent probe.
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockBooth).toHaveBeenCalledTimes(1);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "channel", intent: "META_FEEDBACK", turnNumber: 1 });
    const [after] = await db.select().from(schema.turns).where(eq(schema.turns.id, row.id));
    expect(after?.status).toBe("channel");
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
