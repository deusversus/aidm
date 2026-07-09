import { settleG2 } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { loadDirectionState } from "@/lib/direction/director";
import { plantSeed } from "@/lib/direction/seeds";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { runLayout } from "@/lib/turn/layout";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C7 direction WIRING (the integrator's seams, §7): the pilot plan reaches
 * turn 1's conte, a planted seed's callback appears in a conte within its
 * window (dependency-gated), the Director's spotlight directives surface as
 * spotlight_hints, and G2's step 11 runs a REAL Director cycle (real
 * director/arcs/seeds code, scripted models) that writes the arc row and
 * resets the accumulators. Real Postgres; no live model calls ever.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn(), streamNarration: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockEmbed = vi.mocked(embedTexts);
void streamNarration; // imported only so the module mock stays hermetic

const url = process.env.DATABASE_URL;
if (!url) console.warn("[direction-wiring] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

const VEC = () => Array.from({ length: 1024 }, (_, i) => ((i % 7) + 1) * 0.001);

function armLayoutModels(overrides: { pacer?: Record<string, unknown> } = {}) {
  mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "intent_triage")
      return Promise.resolve({
        intent: "EXPLORATION",
        action: "look around",
        epicness: 0.4,
        special_conditions: [],
        confidence: 0.9,
      }) as never;
    if (opts.name === "pacer_micro")
      return Promise.resolve({
        beat_classification: "investigation",
        strength: "suggestion",
        must_reference: [],
        avoid: [],
        ...overrides.pacer,
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
    return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
  });
}

describe.skipIf(!url)("C7 direction wiring (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(
    extra: Partial<typeof schema.campaigns.$inferInsert> = {},
  ): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "direction-wiring fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
        ...extra,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "direction@example.com" });
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
  });

  it("turn 1 carries the pilot plan: forbidden moves + cold-open as hard constraints, POV in the scene shape", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      directionState: {
        pilot_plan: {
          cold_open_constraints: ["open mid-shift, before the trouble finds him"],
          forbidden_opening_moves: ["revealing the antagonist"],
          opening_pov: "the player's character, mid-shift",
          consumed: false,
        },
      },
    });
    armLayoutModels();

    const result = await runLayout(db, campaignId, 1, "I check the bounty boards.");
    if (result.kind !== "conte") throw new Error("expected a conte");
    expect(result.conte.hard_constraints).toContain(
      "FORBIDDEN OPENING MOVE: revealing the antagonist",
    );
    expect(result.conte.hard_constraints).toContain("open mid-shift, before the trouble finds him");
    expect(result.conte.scene_shape_directive).toContain("Opening POV");
    // epicness stashed for G2's accumulators.
    const [turn] = await db
      .select({ checkpoints: schema.turns.checkpoints })
      .from(schema.turns)
      .where(eq(schema.turns.campaignId, campaignId));
    expect((turn?.checkpoints as { epicness?: number }).epicness).toBeCloseTo(0.4);
  });

  it("a planted seed's callback appears in a conte within its window; a dependency-gated one does not", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await plantSeed(
      db,
      campaignId,
      0,
      {
        op: "plant",
        description: "the dockmaster's unpaid debt",
        payoff_window_from: 2,
        dependencies: [],
      },
      "director",
    );
    await plantSeed(
      db,
      campaignId,
      0,
      {
        op: "plant",
        description: "the syndicate's silent partner",
        payoff_window_from: 2,
        dependencies: ["the dockmaster's unpaid debt"],
      },
      "director",
    );
    armLayoutModels();

    const result = await runLayout(db, campaignId, 6, "I ask around the docks.");
    if (result.kind !== "conte") throw new Error("expected a conte");
    const joined = result.conte.callbacks.join(" | ");
    expect(joined).toContain("the dockmaster's unpaid debt");
    // Gate holds: its dependency is unresolved, so it stays out of the conte.
    expect(joined).not.toContain("the syndicate's silent partner");
  });

  it("Director spotlight directives surface as conte spotlight_hints", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      directionState: {
        spotlight_directives: [{ name: "Vicious", note: "give his absence weight this scene" }],
      },
    });
    armLayoutModels();

    const result = await runLayout(db, campaignId, 2, "I linger at the bar.");
    if (result.kind !== "conte") throw new Error("expected a conte");
    expect(result.conte.spotlight_hints).toContain("Vicious: give his absence weight this scene");
  });

  it("G2 step 11 fires the REAL Director cycle on the hybrid trigger: arc row written, accumulators reset", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      directionState: { last_director_turn: 0, accumulated_epicness: 0, tension_level: 0.3 },
    });
    const turnNumber = 4;
    const [turnRow] = await db
      .insert(schema.turns)
      .values({
        campaignId,
        turnNumber,
        tier: "genga",
        status: "complete",
        playerInput: "I corner the dockmaster.",
        narration: "The dockmaster's hands stop moving.",
        checkpoints: { phase_a: true, phase_b: true, g1: true, epicness: 2.5 },
      })
      .returning({ id: schema.turns.id });
    if (!turnRow) throw new Error("turn insert failed");
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber,
      playerInput: "I corner the dockmaster.",
      narration: "The dockmaster's hands stop moving.",
      turnId: turnNumber,
      provenance: "chronicler_g1",
      confidence: 1,
    });

    mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockJudgment.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "g2_distill")
        return Promise.resolve({
          narrated_fragment: "A quiet threat, finally named.",
          facts: [],
          entity_updates: [],
          confirmed_seed_descriptions: [],
          meta_comments: [],
        }) as never;
      if (typeof opts.name === "string" && opts.name.startsWith("director_"))
        return Promise.resolve({
          analysis: "The dock thread is ready to become the arc's spine.",
          tension_level: 0.55,
          arc_plan: {
            name: "The Quiet Bounty",
            dramatic_question: "Who wants this bounty unclaimed?",
            shape: "rising",
            budget: { unit: "episodes", target: 4, tolerance: 2 },
            phase: "rising",
            payoff_contract: [],
            status: "active",
          },
          clear_override: false,
          scene_shape_notes: ["let silence do the threatening"],
          arc_relevance: [],
          seed_ops: [],
          spotlight_directives: [{ name: "Jet", note: "he noticed the cornering" }],
          demote_criticals: [],
          director_notes: ["hold the noir patience"],
          voice_patterns: [],
        }) as never;
      return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
    });

    await settleG2(db, turnRow.id);

    const state = await loadDirectionState(db, campaignId);
    expect(state.last_director_turn).toBe(turnNumber);
    expect(state.accumulated_epicness).toBe(0); // reset
    expect(state.arc_events).toEqual([]);
    expect(state.tension_level).toBeCloseTo(0.55);
    expect(state.director_notes).toContain("hold the noir patience");
    expect(state.spotlight_directives).toEqual([{ name: "Jet", note: "he noticed the cornering" }]);
    expect(state.phase_state?.phase).toBe("rising");

    const arcs = await db.select().from(schema.arcs).where(eq(schema.arcs.campaignId, campaignId));
    const active = arcs.find((a) => a.name === "The Quiet Bounty");
    expect(active?.status).toBe("active");
    expect(active?.phase).toBe("rising");
    expect(active?.provenance).toBe("director");

    // Step markers landed (incl. the new rolling_checkpoint + media last).
    const [after] = await db
      .select({ checkpoints: schema.turns.checkpoints })
      .from(schema.turns)
      .where(eq(schema.turns.id, turnRow.id));
    const g2 = (after?.checkpoints as { g2?: Record<string, boolean> }).g2;
    expect(g2?.director_trigger).toBe(true);
    expect(g2?.rolling_checkpoint).toBe(true);
    expect(g2?.media).toBe(true);
  });

  it("G2 step 11 accumulates WITHOUT firing below the trigger, and a cycle failure never wedges G2", async () => {
    if (!db) throw new Error("unreachable");
    // Below min turns: last run at turn 3, this is turn 4 → turns_since 1 < 3.
    const campaignId = await makeCampaign({
      directionState: { last_director_turn: 3, accumulated_epicness: 0.5 },
    });
    const [turnRow] = await db
      .insert(schema.turns)
      .values({
        campaignId,
        turnNumber: 4,
        tier: "genga",
        status: "complete",
        playerInput: "x",
        narration: "y",
        checkpoints: { phase_a: true, phase_b: true, g1: true, epicness: 0.7 },
      })
      .returning({ id: schema.turns.id });
    if (!turnRow) throw new Error("turn insert failed");
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber: 4,
      playerInput: "x",
      narration: "y",
      turnId: 4,
      provenance: "chronicler_g1",
      confidence: 1,
    });
    mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockJudgment.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "g2_distill")
        return Promise.resolve({
          narrated_fragment: "f",
          facts: [],
          entity_updates: [],
          confirmed_seed_descriptions: [],
          meta_comments: [],
        }) as never;
      // Any director call in THIS test would be a bug — reject loudly; the
      // wiring must catch it rather than wedge (also proves non-wedging).
      return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
    });

    await settleG2(db, turnRow.id);

    const state = await loadDirectionState(db, campaignId);
    expect(state.last_director_turn).toBe(3); // did not fire
    expect(state.accumulated_epicness).toBeCloseTo(1.2); // 0.5 + 0.7 folded
    const [after] = await db
      .select({ checkpoints: schema.turns.checkpoints })
      .from(schema.turns)
      .where(eq(schema.turns.id, turnRow.id));
    const g2 = (after?.checkpoints as { g2?: Record<string, boolean> }).g2;
    expect(g2?.media).toBe(true); // G2 completed regardless
  });
});
