import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import type { Conte } from "@/lib/types/conte";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachToTurn, executeTurn, submitTurn } from "../runtime";

/**
 * The durable turn (§5.7) against real Postgres with scripted models:
 * crash-replay at both kill points (between phases; mid-Phase-B), same
 * dice on retry, no double episodic write, trailer fallback, research
 * budget caps, and the event-bus attach/replay contract.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn(), streamNarration: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[runtime] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockEmbed = vi.mocked(embedTexts);

const GENGA_INTENT = {
  intent: "EXPLORATION",
  action: "look",
  target: undefined,
  epicness: 0.4,
  special_conditions: [],
  confidence: 0.9,
};
const OUTCOME = {
  success_level: "success",
  difficulty_class: 10,
  modifiers: ["+2 Prepared"],
  narrative_weight: "SIGNIFICANT",
  rationale: "scripted",
};
const SIDECAR = {
  scene_cast_delta: [],
  decision_point: true,
  suggested_moves: ["press him", "walk away"],
  intended_seed_mentions: [],
  notable_beats: ["the hatch was already open"],
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function kaRound(
  blocks: Block[],
  stopReason: "end_turn" | "tool_use",
  opts: { failMidStream?: boolean; gate?: Promise<void> } = {},
) {
  return {
    stream: {
      on: (event: string, cb: (t: string) => void) => {
        if (event === "text") {
          for (const b of blocks) if (b.type === "text") cb(b.text);
        }
      },
    },
    done: async () => {
      if (opts.gate) await opts.gate;
      if (opts.failMidStream) throw new Error("stream died mid-flight (scripted)");
      return {
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
      };
    },
  } as unknown as ReturnType<typeof streamNarration>;
}

/** Arm probe/judgment for a plain genga layout pass. */
function armPhaseA() {
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "intent_triage") return Promise.resolve(GENGA_INTENT) as never;
    if (opts.name === "pacer_micro")
      return Promise.resolve({ beat_classification: "quiet", escalation: false }) as never;
    if (opts.name === "sidecar_fallback") return Promise.resolve(SIDECAR) as never;
    return Promise.reject(new Error(`unscripted probe ${opts.name}`)) as never;
  });
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockJudgment.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "outcome_judgment") return Promise.resolve(OUTCOME) as never;
    if (opts.name === "relevance_filter") return Promise.resolve({ scores: [] }) as never;
    return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
  });
}

describe.skipIf(!url)("Turn Runtime (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "runtime@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Runtime fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: {
          narration: "claude-sonnet-5",
          judgment: "claude-sonnet-5",
          probe: "claude-haiku-4-5",
        },
      })
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

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockStream.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([]);
    armPhaseA();
    // Each test owns a clean turn ledger.
    await db.delete(schema.turns).where(eq(schema.turns.campaignId, campaignId));
    await db
      .delete(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
  });

  it("happy path: submit → phases → episodic write → done event with chips", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockImplementation(() =>
      kaRound(
        [
          { type: "text", text: "The hatch was already open. " },
          { type: "tool_use", id: "t1", name: "commit_scene", input: SIDECAR },
        ],
        "tool_use",
      ),
    );
    const { turnId, turnNumber } = await submitTurn(db, campaignId, "I check the hatch");
    // Attach and wait for terminal.
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      attachToTurn(turnId, (e) => {
        events.push(e.type);
        if (e.type === "done" || e.type === "error") resolve();
      });
    });
    expect(events).toContain("prose");
    expect(events.at(-1)).toBe("done");
    expect(turnNumber).toBe(1);

    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(turn?.status).toBe("complete");
    expect((turn?.sidecar as typeof SIDECAR).decision_point).toBe(true);
    const episodic = await db
      .select()
      .from(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
    expect(episodic).toHaveLength(1);
    expect(episodic[0]?.narration).toContain("hatch was already open");
  });

  it("kill between phases: Phase B fails twice → failed; retry reuses the SAME dice; one episodic row", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockImplementation(() => kaRound([], "end_turn", { failMidStream: true }));
    // The sidecar fallback probe must not rescue an empty scene into success.
    const { turnId } = await submitTurn(db, campaignId, "I confront Jet");
    await new Promise<void>((resolve) => {
      attachToTurn(turnId, (e) => {
        if (e.type === "error" || e.type === "done") resolve();
      });
    });
    const [failed] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(failed?.status).toBe("failed");
    const conte1 = failed?.conte as Conte;
    const dice1 = conte1.mechanics?.rolls[0];
    expect(dice1).toBeDefined();

    // "Restart": the retry path reopens at the checkpointed phase.
    await db
      .update(schema.turns)
      .set({ status: "phase_a_complete" })
      .where(eq(schema.turns.id, turnId));
    mockStream.mockImplementation(() =>
      kaRound(
        [
          { type: "text", text: "Jet doesn't look up. " },
          {
            type: "tool_use",
            id: "t2",
            name: "commit_scene",
            input: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
          },
        ],
        "tool_use",
      ),
    );
    await executeTurn(db, turnId);

    const [done] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(done?.status).toBe("complete");
    const conte2 = done?.conte as Conte;
    expect(conte2.mechanics?.rolls[0]).toEqual(dice1); // same dice — never re-judged
    const episodic = await db
      .select()
      .from(schema.episodicRecords)
      .where(
        and(
          eq(schema.episodicRecords.campaignId, campaignId),
          eq(schema.episodicRecords.narration, "Jet doesn't look up. "),
        ),
      );
    expect(episodic).toHaveLength(1);
  });

  it("mid-Phase-B kill: attempt 1 dies mid-stream; auto-retry same conte; reset event; single write", async () => {
    if (!db) throw new Error("unreachable");
    let attempt = 0;
    mockStream.mockImplementation(() => {
      attempt += 1;
      if (attempt === 1)
        return kaRound([{ type: "text", text: "partial prose that will vanish" }], "end_turn", {
          failMidStream: true,
        });
      return kaRound(
        [
          { type: "text", text: "The scene lands clean. " },
          {
            type: "tool_use",
            id: "t3",
            name: "commit_scene",
            input: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
          },
        ],
        "tool_use",
      );
    });
    const { turnId } = await submitTurn(db, campaignId, "I follow the corgi");
    const events: { type: string }[] = [];
    await new Promise<void>((resolve) => {
      attachToTurn(turnId, (e) => {
        events.push(e);
        if (e.type === "done" || e.type === "error") resolve();
      });
    });
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    const episodic = await db
      .select()
      .from(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
    expect(episodic).toHaveLength(1);
    expect(episodic[0]?.narration).toBe("The scene lands clean. ");
  });

  it("orphaned phase_b_complete resume REPLAYS the persisted prose, then finishes G1 (§5.7)", async () => {
    if (!db) throw new Error("unreachable");
    // Simulate a crash between the Phase-B checkpoint and G1: a durable turn
    // with narration + sidecar persisted, phase_b marked, g1 not, and an
    // EMPTY event bus (post-restart). No stream mock should be consulted.
    mockStream.mockImplementation(() => {
      throw new Error("Phase B must not run on a phase_b-checkpointed resume");
    });
    const [row] = await db
      .insert(schema.turns)
      .values({
        campaignId,
        turnNumber: 1,
        tier: "genga",
        status: "phase_b_complete",
        playerInput: "I read the room",
        conte: { turn_id: 1, tier: "genga", degraded: false },
        narration: "The bar exhaled smoke and old grievances.",
        sidecar: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
        checkpoints: { phase_a: true, phase_b: true },
      })
      .returning({ id: schema.turns.id });
    if (!row) throw new Error("insert failed");

    const events: { type: string; text?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("resume hung")), 10_000);
      attachToTurn(row.id, (e) => {
        events.push(e);
        if (e.type === "done" || e.type === "error") {
          clearTimeout(timer);
          resolve();
        }
      });
      void executeTurn(db, row.id);
    });
    const prose = events.find((e) => e.type === "prose");
    expect(prose?.text).toContain("old grievances");
    expect(events.at(-1)?.type).toBe("done");
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, row.id));
    expect(turn?.status).toBe("complete");
    const episodic = await db
      .select()
      .from(schema.episodicRecords)
      .where(eq(schema.episodicRecords.campaignId, campaignId));
    expect(episodic).toHaveLength(1);
    expect(episodic[0]?.narration).toContain("old grievances");
  });

  it("Phase-A failure surfaces a typed retryable error and wedges nothing (§5.7)", async () => {
    if (!db) throw new Error("unreachable");
    // The intent probe outage: runLayout throws before any checkpoint.
    // biome-ignore lint/suspicious/noExplicitAny: harness
    mockProbe.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "intent_triage")
        return Promise.reject(new Error("probe outage (scripted)")) as never;
      return Promise.resolve({}) as never;
    });
    const { turnId } = await submitTurn(db, campaignId, "I look around");
    const events: { type: string; retryable?: boolean }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Phase-A failure hung — no terminal event")), 15_000);
      attachToTurn(turnId, (e) => {
        events.push(e);
        if (e.type === "error" || e.type === "done") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { retryable?: boolean }).retryable).toBe(true);
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(turn?.status).toBe("failed");

    // A reconnect (executeTurn again on the failed turn) must NOT re-run —
    // the terminal-status guard prevents unbounded re-execution.
    let extraProbe = false;
    // biome-ignore lint/suspicious/noExplicitAny: harness
    mockProbe.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "intent_triage") extraProbe = true;
      return Promise.reject(new Error("should not be called")) as never;
    });
    await executeTurn(db, turnId);
    expect(extraProbe).toBe(false);
  });

  it("trailer fallback: no commit_scene → probe reconstructs; checkpoint records it", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockImplementation(() =>
      kaRound([{ type: "text", text: "Prose without a trailer." }], "end_turn"),
    );
    const { turnId } = await submitTurn(db, campaignId, "I light a cigarette");
    await new Promise<void>((resolve) => {
      attachToTurn(turnId, (e) => {
        if (e.type === "done" || e.type === "error") resolve();
      });
    });
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(turn?.status).toBe("complete");
    expect((turn?.checkpoints as { trailer_fallback?: boolean }).trailer_fallback).toBe(true);
    expect((turn?.sidecar as typeof SIDECAR).notable_beats).toBeDefined();
  });

  it("research budget: calls past the cap get the exhausted notice; ladder cap_research_0 strips tools", async () => {
    if (!db) throw new Error("unreachable");
    const { runKeyAnimator } = await import("../ka");
    const bebop = bebopContract();
    const toolUse = (i: number): Block => ({
      type: "tool_use",
      id: `r${i}`,
      name: "recall_scene",
      input: { turn_number: 1 },
    });
    let round = 0;
    const toolInputs: string[] = [];
    mockStream.mockImplementation((opts: Parameters<typeof streamNarration>[0]) => {
      round += 1;
      toolInputs.push(...(opts.tools ?? []).map((t) => t.name));
      if (round <= 3) return kaRound([toolUse(round)], "tool_use");
      return kaRound(
        [
          { type: "text", text: "Done researching. " },
          {
            type: "tool_use",
            id: "t9",
            name: "commit_scene",
            input: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
          },
        ],
        "tool_use",
      );
    });
    const result = await runKeyAnimator(db, {
      campaignId,
      turnNumber: 99,
      conte: {
        turn_id: 99,
        tier: "genga",
        charter_amendments: "",
        scene_shape_directive: "",
        canonicality_directives: [],
        hard_constraints: [],
        callbacks: [],
        memories: [],
        canon_chunks: [],
        entity_cards: [],
        spotlight_hints: [],
        active_consequences: [],
        world_assertion_notes: [],
        research_findings: [],
        degraded: false,
      } as unknown as Conte,
      playerInput: "test",
      system: [{ type: "text", text: "settei" }],
      selection: {
        narration: "claude-sonnet-5",
        judgment: "claude-sonnet-5",
        probe: "claude-haiku-4-5",
      },
      effort: "high",
      maxTokens: 1_000,
      kaResearchCalls: 2, // genga budget
      ladderSteps: [],
      profileIds: [],
      emit: () => {},
    });
    expect(result.researchCalls).toBe(2); // third call got the exhausted notice
    expect(result.sidecar).not.toBeNull();

    // Ladder cap_research_0: the research tools never reach the model.
    mockStream.mockClear();
    mockStream.mockImplementation((opts: Parameters<typeof streamNarration>[0]) => {
      expect((opts.tools ?? []).map((t) => t.name)).toEqual(["commit_scene"]);
      return kaRound(
        [
          { type: "text", text: "No research. " },
          {
            type: "tool_use",
            id: "t10",
            name: "commit_scene",
            input: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
          },
        ],
        "tool_use",
      );
    });
    const capped = await runKeyAnimator(db, {
      campaignId,
      turnNumber: 100,
      conte: {
        turn_id: 100,
        tier: "sakuga",
        charter_amendments: "",
        scene_shape_directive: "",
        canonicality_directives: [],
        hard_constraints: [],
        callbacks: [],
        memories: [],
        canon_chunks: [],
        entity_cards: [],
        spotlight_hints: [],
        active_consequences: [],
        world_assertion_notes: [],
        research_findings: [],
        degraded: false,
      } as unknown as Conte,
      playerInput: "test",
      system: [{ type: "text", text: "settei" }],
      selection: {
        narration: "claude-sonnet-5",
        judgment: "claude-sonnet-5",
        probe: "claude-haiku-4-5",
      },
      effort: "xhigh",
      maxTokens: 1_000,
      kaResearchCalls: 4,
      ladderSteps: ["skip_validation_retry", "timebox_pacer", "cap_research_2", "cap_research_0"],
      profileIds: [bebop.anchors_used[0] ?? "x"],
      emit: () => {},
    });
    expect(capped.researchCalls).toBe(0);
  });

  it("submit while a turn is open → TurnInProgressError; event bus replays for late attaches", async () => {
    if (!db) throw new Error("unreachable");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockStream.mockImplementation(() =>
      kaRound(
        [
          { type: "text", text: "held scene" },
          {
            type: "tool_use",
            id: "t",
            name: "commit_scene",
            input: { ...SIDECAR, decision_point: false, suggested_moves: undefined },
          },
        ],
        "tool_use",
        { gate },
      ),
    );
    const { turnId } = await submitTurn(db, campaignId, "first input");
    await expect(submitTurn(db, campaignId, "second input")).rejects.toThrow(/already in progress/);
    release();
    // Late attach after completion inside the grace window replays terminal.
    await new Promise<void>((resolve) => {
      attachToTurn(turnId, (e) => {
        if (e.type === "done") resolve();
      });
    });
  });
});
