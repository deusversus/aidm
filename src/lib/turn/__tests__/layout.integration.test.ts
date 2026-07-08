import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import type { Conte } from "@/lib/types/conte";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runLayout } from "../layout";
import { computeHeat, fetchCandidates } from "../retrieval";

/**
 * Layout DAG against real Postgres with a recorded-response harness: model
 * calls are scripted by name; Voyage embeddings are deterministic basis
 * vectors so ANN ordering is controlled. The plan's C4 test list: DAG
 * ordering, filter caps, checkpoint write, boost accumulation, heat SQL
 * agreement, douga contract.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[layout] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockEmbed = vi.mocked(embedTexts);

/** Basis vector: 1 at index i, orthogonal to every other basis vector. */
function basis(i: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return v;
}

/** Recorded-response harness: answers by call `name`, records the order. */
function armHarness(script: Record<string, unknown | ((prompt: string) => unknown)>) {
  const calls: string[] = [];
  const dispatch = (opts: { name: string; prompt: string }) => {
    calls.push(opts.name);
    const entry = script[opts.name];
    if (entry === undefined) throw new Error(`unscripted call: ${opts.name}`);
    return Promise.resolve(typeof entry === "function" ? entry(opts.prompt) : entry);
  };
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockJudgment.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
  return calls;
}

const GENGA_INTENT = {
  intent: "EXPLORATION",
  action: "search",
  target: "the derelict",
  epicness: 0.4,
  special_conditions: [],
  confidence: 0.9,
};

describe.skipIf(!url)("Layout (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;
  const memoryIds: string[] = [];

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "layout@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Layout fixture",
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

    const env = { turnId: 1, provenance: "test_seed", confidence: 0.9 };
    // Memories: two aligned with the query basis(0), one orthogonal, one hot.
    const rows = [
      {
        content: "Vicious was seen near the derelict freighter",
        category: "event",
        embedding: basis(0),
        baseHeat: 50,
        lastBoostedTurn: 1,
      },
      {
        content: "The crew is broke; the fridge is empty again",
        category: "fact",
        embedding: basis(0).map((x, i) => (i === 0 ? 0.9 : i === 1 ? 0.44 : 0)),
        baseHeat: 50,
        lastBoostedTurn: 1,
      },
      {
        content: "Jet hates the casino district",
        category: "fact",
        embedding: basis(5),
        baseHeat: 50,
        lastBoostedTurn: 1,
      },
      {
        content: "Julia's promise binds them both",
        category: "relationship",
        embedding: basis(7),
        baseHeat: 100,
        lastBoostedTurn: 2,
      },
    ];
    for (const r of rows) {
      const [m] = await db
        .insert(schema.semanticMemories)
        .values({ campaignId, heatFloor: 1, plotCritical: false, ...env, ...r })
        .returning({ id: schema.semanticMemories.id });
      if (m) memoryIds.push(m.id);
    }
    await db.insert(schema.criticalFacts).values({
      campaignId,
      content: "Finitude: finite — only the player may change this.",
      category: "contract",
      ...env,
      confidence: 1,
    });
    await db
      .insert(schema.overrides)
      .values({ campaignId, content: "Never harm the corgi.", ...env });
    await db.insert(schema.seeds).values({
      campaignId,
      description: "The bounty that knows their names",
      status: "planted",
      plantedTurn: 1,
      payoffWindow: { from: 1, to: 20 },
      urgency: 0.5,
      ...env,
    });
    await db.insert(schema.entities).values({
      campaignId,
      name: "Vicious",
      entityType: "npc",
      block: "Cold, patient, already speaking in past tense.",
      ...env,
    });
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

  beforeEach(() => {
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([basis(0)]);
  });

  it("genga DAG: retrieval → filter → outcome; conte assembled; checkpoint + boosts written", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
    const calls = armHarness({
      intent_triage: GENGA_INTENT,
      pacer_micro: { beat_classification: "investigation", tone: "wary", escalation: false },
      relevance_filter: {
        // Keep the two aligned memories, drop everything below the 0.4 floor.
        scores: [
          { index: 0, score: 0.9 },
          { index: 1, score: 0.6 },
          { index: 2, score: 0.2 },
          { index: 3, score: 0.1 },
        ],
      },
      // The judge CONTRADICTS its own math (claims failure on a clean make):
      // the code must recompute the band from the die and correct it.
      outcome_judgment: {
        success_level: "failure",
        difficulty_class: 10,
        modifiers: ["+5 Prepared"],
        narrative_weight: "SIGNIFICANT",
        rationale: "scripted",
      },
    });

    const result = await runLayout(
      db,
      campaignId,
      5,
      "I search the derelict for Vicious",
      () => {},
    );
    expect(result.kind).toBe("conte");
    if (result.kind !== "conte") return;
    const conte = result.conte;

    // DAG ordering: triage first, outcome judged after retrieval+filter.
    expect(calls[0]).toBe("intent_triage");
    expect(calls.indexOf("outcome_judgment")).toBeGreaterThan(calls.indexOf("relevance_filter"));

    // The die never lies: roll ≥... whatever was rolled, band must equal code math.
    const roll = conte.mechanics?.rolls[0];
    expect(roll).toBeDefined();
    if (!roll) return;
    expect(roll.modifier).toBe(5);
    expect(roll.total).toBe(roll.rolled + 5);
    const expected =
      roll.rolled === 1
        ? "critical_failure"
        : roll.rolled === 20 || roll.total >= 20
          ? "critical_success"
          : roll.total >= 10
            ? "success"
            : roll.total >= 6
              ? "partial_success"
              : "failure";
    expect(conte.outcome?.success_level).toBe(expected);

    // Filter floor + cap: the 0.2/0.1-scored candidates are out.
    expect(conte.memories.length).toBeLessThanOrEqual(5);
    expect(conte.memories.some((m) => m.content.includes("casino district"))).toBe(false);
    expect(conte.memories.some((m) => m.content.includes("derelict freighter"))).toBe(true);

    // Hard core present: critical + override, every tier.
    expect(conte.hard_constraints.some((c) => c.includes("Finitude"))).toBe(true);
    expect(conte.hard_constraints.some((c) => c.includes("corgi"))).toBe(true);

    // Callbacks from the seed ledger; entity card via presence detection.
    expect(conte.callbacks.some((c) => c.includes("bounty"))).toBe(true);
    expect(conte.entity_cards.some((c) => c.includes("Vicious"))).toBe(true);

    // Checkpoint: the turns row carries the conte (retry-same-dice substrate).
    const [turnRow] = await db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.turnNumber, 5)));
    expect(turnRow?.status).toBe("phase_a_complete");
    expect((turnRow?.checkpoints as { phase_a?: boolean }).phase_a).toBe(true);
    const persisted = turnRow?.conte as Conte;
    expect(persisted.mechanics?.rolls[0]?.rolled).toBe(roll.rolled);

    // Boost accumulation: write-only rows for the conte's memories.
    const boosts = await db
      .select()
      .from(schema.heatBoosts)
      .where(
        and(eq(schema.heatBoosts.campaignId, campaignId), eq(schema.heatBoosts.turnNumber, 5)),
      );
    expect(boosts.length).toBeGreaterThan(0);
  });

  it("douga contract: no consultants, synthetic success, hard core still present", async () => {
    if (!db) throw new Error("unreachable");
    const calls = armHarness({
      intent_triage: { ...GENGA_INTENT, intent: "DEFAULT", epicness: 0.05 },
    });
    const result = await runLayout(db, campaignId, 6, "I pour a coffee", () => {});
    expect(result.kind).toBe("conte");
    if (result.kind !== "conte") return;
    expect(result.conte.tier).toBe("douga");
    expect(calls).toEqual(["intent_triage"]); // no retrieval filter, no judge, no pacer
    expect(result.conte.outcome?.narrative_weight).toBe("MINOR");
    // §5.1 douga row: retrieval NONE — no memories, no fan-out members.
    expect(result.conte.memories).toHaveLength(0);
    expect(result.conte.callbacks).toHaveLength(0);
    expect(result.conte.entity_cards).toHaveLength(0);
    expect(result.conte.active_consequences).toHaveLength(0);
    expect(result.conte.hard_constraints.some((c) => c.includes("corgi"))).toBe(true);
    expect(result.effort).toBe("low");
    expect(result.ladderSteps).toHaveLength(0);
  });

  it("channel inputs route out before the story pipeline (§5.4)", async () => {
    if (!db) throw new Error("unreachable");
    armHarness({
      intent_triage: { ...GENGA_INTENT, intent: "META_FEEDBACK", epicness: 0 },
    });
    const result = await runLayout(db, campaignId, 7, "(too flowery, dial it back)", () => {});
    expect(result.kind).toBe("channel");
  });

  it("heat: the SQL expression agrees with computeHeat on seeded rows", async () => {
    if (!db) throw new Error("unreachable");
    mockEmbed.mockResolvedValue([basis(0)]);
    // Small budget so ANN can't sweep the whole table — the hot-baseline
    // channel must ADD the unretrieved high-heat memory, not duplicate one.
    const candidates = await fetchCandidates(db, campaignId, 10, ["derelict"], 1);
    expect(candidates.length).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const c of candidates) {
      const row = byId.get(c.id);
      expect(row).toBeDefined();
      if (!row) continue;
      expect(c.heat).toBeCloseTo(computeHeat(row, 10), 3);
    }
    // The recently-boosted relationship memory rides the hot-baseline channel.
    const hot = candidates.find((c) => c.layer === "hot_baseline");
    expect(hot?.content).toContain("Julia");
  });
});
