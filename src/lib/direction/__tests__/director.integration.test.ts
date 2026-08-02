import * as schema from "@/lib/db/schema";
import { LOOPED_LARGE } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { ArcOverride } from "@/lib/types/arc";
import {
  DIRECTOR_MAX_TOOL_ROUNDS,
  DirectionState,
  type DirectorOutput,
} from "@/lib/types/direction";
import type { OpeningStatePackage } from "@/lib/types/opening";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Director (blueprint §7.1, C7) against real Postgres for the state
 * load/save round-trip, the demotion write, and the pilot-plan write — with
 * the model call scripted (callJudgment mocked) and the arcs/seeds
 * dependencies vi.mocked so this suite is hermetic to Director LOGIC and never
 * calls a live model.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});
vi.mock("@/lib/direction/arcs", () => ({
  ensureSeriesScaffold: vi.fn(),
  getActiveArc: vi.fn(),
  applyArcPlan: vi.fn(),
  closeEpisode: vi.fn(),
  arcPosition: vi.fn(),
  payoffDebt: vi.fn(),
  budgetPriorFor: vi.fn(),
  expectedTension: vi.fn(),
  seriesBudget: vi.fn(),
  seasonPosition: vi.fn(),
  seasonBoundary: vi.fn(),
}));
vi.mock("@/lib/direction/seeds", () => ({
  plantSeed: vi.fn(),
  settleSeed: vi.fn(),
  callbackReadySeeds: vi.fn(),
  overdueSeeds: vi.fn(),
  overdueTensionBump: vi.fn(),
  seedDossier: vi.fn(),
}));
// §7.6's batched adjudication runs at the TOP of the cycle (its own suite owns
// its behaviour); here we only pin that the cycle calls it, once, before the
// dossier it settles the ledger for.
vi.mock("@/lib/direction/adjudication", () => ({ adjudicateSeeds: vi.fn() }));

import * as adjudication from "@/lib/direction/adjudication";
import * as arcs from "@/lib/direction/arcs";
import {
  accumulate,
  directorStartup,
  evaluateDirectorTrigger,
  loadDirectionState,
  runDirectorCycle,
  saveDirectionState,
} from "@/lib/direction/director";
import * as seeds from "@/lib/direction/seeds";

const mockJudgment = vi.mocked(callJudgment);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[director] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: ArcRow is a wide drizzle inferred row; the test only needs a few fields.
function fakeArc(campaignId: string): any {
  return {
    id: "arc-xyz",
    campaignId,
    name: "The Ganymede Bounty",
    stratum: "arc",
    dramaticQuestion: "Do they collect, or does it collect them?",
    shape: "fragmented",
    budget: { unit: "episodes", target: 6, tolerance: 2 },
    phase: "rising",
    payoffContract: [],
    status: "active",
    canonWeight: "full_canon",
    parentId: null,
    turnId: 0,
    provenance: "director",
    confidence: 0.9,
    tombstonedAt: null,
  };
}

function directorOutput(over: Partial<DirectorOutput> = {}): DirectorOutput {
  return {
    analysis: "investigation digest — internal, never player-facing",
    tension_level: 0.5,
    arc_plan: {
      name: "The Ganymede Bounty",
      dramatic_question: "Do they collect, or does it collect them?",
      shape: "fragmented",
      budget: { unit: "episodes", target: 6, tolerance: 2 },
      phase: "rising",
      payoff_contract: [],
      status: "active",
    },
    clear_override: false,
    scene_shape_notes: [],
    arc_relevance: [],
    seed_ops: [],
    spotlight_directives: [],
    demote_criticals: [],
    director_notes: [],
    voice_patterns: [],
    ...over,
  } as DirectorOutput;
}

const FORBIDDEN = ["no amnesia cold open", "don't kill a named character in scene 1"];
function ospFixture(): OpeningStatePackage {
  return {
    director_inputs: {
      opening_situation: "A bounty gone sideways in Ganymede's freeze.",
      spark_reading: "The walk-toward-it-anyway moment, restated as pressure.",
      suggested_first_arc_question: "Do they collect, or does it collect them?",
    },
    animation_inputs: { forbidden_opening_moves: FORBIDDEN, opening_pov: "Spike Spiegel" },
    constraints: [],
    uncertainties: [],
    briefs: [],
    orphan_facts: [],
  };
}

// ---------------------------------------------------------------------------
// Pure logic — no DB required.
// ---------------------------------------------------------------------------

const st = (partial: Record<string, unknown>) => DirectionState.parse(partial);

describe("evaluateDirectorTrigger (v3 hybrid trigger, verbatim)", () => {
  it("does not fire below DIRECTOR_MIN_TURNS_BETWEEN", () => {
    // turnsSince = 4 - 2 = 2 (< 3), even with epicness over threshold.
    const r = evaluateDirectorTrigger(st({ last_director_turn: 2, accumulated_epicness: 5 }), 4);
    expect(r.fire).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("fires on epicness ≥ 2.0 once min-turns is met", () => {
    const r = evaluateDirectorTrigger(st({ last_director_turn: 0, accumulated_epicness: 2.0 }), 3);
    expect(r.fire).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("epicness"))).toBe(true);
  });

  it("fires on any arc event once min-turns is met", () => {
    const r = evaluateDirectorTrigger(
      st({ last_director_turn: 0, accumulated_epicness: 0, arc_events: ["level_up"] }),
      3,
    );
    expect(r.fire).toBe(true);
    expect(r.reasons).toContain("events:1");
  });

  it("fires on the 8-turn max interval alone", () => {
    const r = evaluateDirectorTrigger(st({ last_director_turn: 0 }), 8);
    expect(r.fire).toBe(true);
    expect(r.reasons).toContain("max_interval");
  });

  it("never fires at turn 0", () => {
    const r = evaluateDirectorTrigger(st({ last_director_turn: 0, accumulated_epicness: 9 }), 0);
    expect(r.fire).toBe(false);
  });

  it("does not fire when min-turns is met but no sub-clause holds", () => {
    // turnsSince = 3 (≥ min), epicness 1.0 (< 2.0), no events, 3 < 8.
    const r = evaluateDirectorTrigger(st({ last_director_turn: 0, accumulated_epicness: 1.0 }), 3);
    expect(r.fire).toBe(false);
    expect(r.reasons).toEqual([]);
  });
});

describe("accumulate", () => {
  it("folds epicness and events without mutating the input", () => {
    const s0 = st({ accumulated_epicness: 1, arc_events: ["a"] });
    const s1 = accumulate(s0, { epicness: 0.5, events: ["b", "c"] });
    expect(s1.accumulated_epicness).toBe(1.5);
    expect(s1.arc_events).toEqual(["a", "b", "c"]);
    expect(s0.accumulated_epicness).toBe(1);
    expect(s0.arc_events).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Real Postgres.
// ---------------------------------------------------------------------------

describe.skipIf(!url)("Director (real Postgres, scripted model)", () => {
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
        title: "director fixture",
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
    await db.insert(schema.players).values({ id: playerId, email: "director@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      for (const id of campaignIds) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
      }
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(() => {
    mockJudgment.mockReset();
    vi.mocked(arcs.getActiveArc).mockReset();
    vi.mocked(arcs.arcPosition)
      .mockReset()
      .mockResolvedValue({ consumed: 4, target: 6, fraction: 0.66 });
    vi.mocked(arcs.expectedTension).mockReset().mockReturnValue(0.5);
    vi.mocked(arcs.seriesBudget)
      .mockReset()
      .mockResolvedValue({ unit: "episodes", target: 24, tolerance: 12 });
    vi.mocked(arcs.payoffDebt)
      .mockReset()
      .mockReturnValue({ openItems: 1, remaining: 2, rushed: false });
    vi.mocked(arcs.applyArcPlan)
      .mockReset()
      .mockResolvedValue({ arcId: "arc-xyz", phaseChanged: true });
    vi.mocked(arcs.closeEpisode).mockReset().mockResolvedValue(undefined);
    vi.mocked(arcs.ensureSeriesScaffold)
      .mockReset()
      .mockResolvedValue({ seriesId: "s", seasonId: "se" });
    vi.mocked(arcs.budgetPriorFor)
      .mockReset()
      .mockReturnValue({ unit: "episodes", target: 3, tolerance: 1 });
    // §7.1 M3 C4: mid-season by default — the evolution gate is CLOSED unless a
    // test opens it, which is the shape of ordinary play.
    vi.mocked(arcs.seasonBoundary).mockReset().mockResolvedValue(null);
    vi.mocked(seeds.seedDossier).mockReset().mockResolvedValue("Seed ledger: (empty)");
    vi.mocked(seeds.overdueSeeds).mockReset().mockResolvedValue([]);
    vi.mocked(seeds.overdueTensionBump).mockReset().mockReturnValue(0);
    vi.mocked(seeds.plantSeed).mockReset().mockResolvedValue({ seedId: "seed-1", notes: [] });
    vi.mocked(seeds.settleSeed).mockReset().mockResolvedValue({ seedId: "seed-2" });
  });

  it("round-trips DirectionState through campaigns.direction_state", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();

    const loaded0 = await loadDirectionState(db, campaignId);
    expect(loaded0.last_director_turn).toBe(0); // zod defaults on {}
    expect(loaded0.tension_level).toBe(0.3);

    const next = { ...loaded0, tension_level: 0.7, director_notes: ["hold the falling beat"] };
    await saveDirectionState(db, campaignId, next);

    const loaded1 = await loadDirectionState(db, campaignId);
    expect(loaded1.tension_level).toBe(0.7);
    expect(loaded1.director_notes).toEqual(["hold the falling beat"]);
  });

  it("runs the full cycle: applies plan, stamps arc_override, demotes a critical, resets accumulators", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));

    // Seed the demotion cast (§6.3): a PROMOTED critical with its semantic
    // source (the Director may demote it — back to semantic-with-floor), and
    // an sz_fact matching the same demote string (player authority — the
    // category guard must leave it standing).
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    const [sourceMemory] = await db
      .insert(schema.semanticMemories)
      .values({
        campaignId,
        content: "The safe combination is 4021.",
        embedding,
        category: "fact",
        baseHeat: 100,
        heatFloor: 1,
        lastBoostedTurn: 1,
        plotCritical: true,
        turnId: 1,
        provenance: "chronicler_g2",
        confidence: 0.8,
      })
      .returning({ id: schema.semanticMemories.id });
    if (!sourceMemory) throw new Error("semantic seed failed");
    await db.insert(schema.criticalFacts).values([
      {
        campaignId,
        content: "The safe combination is 4021.",
        category: "promoted",
        sourceMemoryId: sourceMemory.id,
        turnId: 1,
        provenance: "chronicler_promotion",
        confidence: 0.9,
      },
      {
        campaignId,
        content: "HARD LINE (absolute): the safe combination was Julia's dying gift.",
        category: "sz_fact",
        turnId: 0,
        provenance: "sz_resolution",
        confidence: 1,
      },
    ]);
    // Prime the accumulators so the reset is observable.
    await db
      .update(schema.campaigns)
      .set({
        directionState: {
          last_director_turn: 3,
          accumulated_epicness: 4,
          arc_events: ["level_up", "boss_defeat"],
          pending_flags: ["flag:x"],
          director_notes: ["old note"],
          tension_level: 0.5,
        },
      })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(
      directorOutput({
        tension_level: 0.72,
        arc_override: {
          arc_name: "Cold Open on Ganymede",
          transition_signal: "Spike leaves the ice",
          dna_shifts: [
            { axis: "darkness", value: 8 },
            { axis: "not_a_real_axis", value: 5 },
          ],
          composition_shifts: [],
        },
        scene_shape_trajectory: "hold the ache before the cut",
        scene_shape_notes: ["end on a smash cut"],
        arc_relevance: [
          { axis: "darkness", relevance: 7 },
          { axis: "intimacy", relevance: 5 },
        ],
        seed_ops: [
          { op: "plant", description: "a photograph left behind", dependencies: [] },
          { op: "resolve", seed_description: "the outstanding debt", dependencies: [] },
        ],
        demote_criticals: ["safe combination"],
        director_notes: ["let the bounty breathe one more scene"],
        voice_patterns: ["clipped, jazz-phrased"],
      }) as never,
    );

    const output = await runDirectorCycle(db, campaignId, 8);
    expect(output.tension_level).toBe(0.72);

    // The judgment call carried the investigation toolkit and budget.
    const callOpts = mockJudgment.mock.calls[0]?.[1];
    expect(callOpts?.tools?.length).toBeGreaterThan(0);
    expect(callOpts?.maxToolRounds).toBe(DIRECTOR_MAX_TOOL_ROUNDS);
    expect(callOpts?.effort).toBe("high");
    expect(callOpts?.maxTokens).toBe(LOOPED_LARGE);
    // M2R5 C2: the loop re-sends persona + dossier every round, seconds apart —
    // 5m, so the 1.25× write amortizes across up to six reads at 0.1×.
    expect(callOpts?.cacheHead).toBe("5m");

    // M2R R2: the dossier carries the Series contract — finitude's behavioral
    // consumer (§8) plus the series-horizon line (the budget's reader).
    const dossierPrompt = String((callOpts as { prompt?: string })?.prompt ?? "");
    expect(dossierPrompt).toContain("## Series contract");
    expect(dossierPrompt).toContain("FINITE");
    expect(dossierPrompt).toContain("planned finale across seasons");
    expect(dossierPrompt).toContain("Series horizon: ~24 episodes, ± 12.");

    // §6.3 dailies line: the Director sees the demotable population, not just
    // the layer size (2 seeded criticals, 1 of them promoted).
    expect(dossierPrompt).toContain("2 active critical fact(s), of which 1 promoted");

    // arc plan applied, with the current turn stamped.
    expect(vi.mocked(arcs.applyArcPlan)).toHaveBeenCalledWith(
      expect.anything(),
      campaignId,
      8,
      expect.objectContaining({ name: "The Ganymede Bounty" }),
    );

    // arc_override written to the campaign with started_turn stamped.
    const [c] = await db
      .select({ arcOverride: schema.campaigns.arcOverride })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const parsedOverride = ArcOverride.parse(c?.arcOverride);
    expect(parsedOverride).toMatchObject({
      arc_name: "Cold Open on Ganymede",
      started_turn: 8,
      transition_signal: "Spike leaves the ice",
    });
    // Shift pairs convert to the stored partial; unknown axes are stripped
    // (the model-facing schema stays lean — strict-output grammar cap).
    expect(parsedOverride.dna).toEqual({ darkness: 8 });

    // The PROMOTED fact was demoted, not deleted; the sz_fact matching the
    // same string survived the category guard (player authority, §6.3).
    const crits = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    const promoted = crits.find((c) => c.category === "promoted");
    const szFact = crits.find((c) => c.category === "sz_fact");
    expect(promoted?.demotedAt).not.toBeNull();
    expect(szFact).toBeDefined();
    expect(szFact?.demotedAt).toBeNull();

    // Re-homed to semantic-with-floor: the no-decay pin released, floor 40.
    const [source] = await db
      .select({
        plotCritical: schema.semanticMemories.plotCritical,
        heatFloor: schema.semanticMemories.heatFloor,
      })
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.id, sourceMemory.id));
    expect(source?.plotCritical).toBe(false);
    expect(source?.heatFloor).toBe(40);

    // seed ops forwarded.
    expect(vi.mocked(seeds.plantSeed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(seeds.settleSeed)).toHaveBeenCalledTimes(1);

    // §7.6: the ledger settles BEFORE the Director reads it — one batched
    // adjudication per cycle, and the dossier it plans against is current.
    expect(vi.mocked(adjudication.adjudicateSeeds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adjudication.adjudicateSeeds)).toHaveBeenCalledWith(db, campaignId, 8);
    const adjudicatedAt = vi.mocked(adjudication.adjudicateSeeds).mock.invocationCallOrder[0] ?? 0;
    expect(adjudicatedAt).toBeLessThan(mockJudgment.mock.invocationCallOrder[0] ?? 0);

    // The push-out op is stated where the model can act on it (the C1 slip).
    const dossier = String(mockJudgment.mock.calls[0]?.[1]?.prompt);
    expect(dossier).toContain("adjust_window");

    // State updated + accumulators reset + phase_state stamped (phaseChanged).
    const state = await loadDirectionState(db, campaignId);
    expect(state.accumulated_epicness).toBe(0);
    expect(state.arc_events).toEqual([]);
    expect(state.pending_flags).toEqual([]);
    expect(state.last_director_turn).toBe(8);
    expect(state.tension_level).toBe(0.72);
    expect(state.director_notes).toEqual(["let the bounty breathe one more scene"]);
    expect(state.voice_patterns).toEqual(["clipped, jazz-phrased"]);
    expect(state.arc_relevance).toEqual({ darkness: 7, intimacy: 5 });
    expect(state.scene_shape?.notes).toEqual(["end on a smash cut"]);
    expect(state.phase_state).toEqual({ arc_id: "arc-xyz", phase: "rising", entered_at_turn: 8 });
  });

  it("an over-count cycle lands CLAMPED — the plan is never lost to a surplus note (2026-08-01)", async () => {
    if (!db) throw new Error("unreachable");
    // The structured-output grammar strips minItems/maxItems, so `.max(5)` on
    // director_notes could never hold the model to five — it could only fail
    // the parse and throw away the whole cycle: arc plan, seed ops, demotions.
    // Surplus entries drop; everything else must still land.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);

    mockJudgment.mockResolvedValue(
      directorOutput({
        // Out of band on both ends, and out of count on every list.
        tension_level: 1.4,
        scene_shape_notes: many(6, "note"),
        arc_relevance: Array.from({ length: 8 }, (_, i) => ({
          axis: `axis_${i}`,
          relevance: i === 0 ? 42 : 5,
        })),
        seed_ops: Array.from({ length: 9 }, (_, i) => ({
          op: "plant" as const,
          description: `seed ${i}`,
          dependencies: [],
        })),
        spotlight_directives: many(5, "npc").map((name) => ({ name, note: "give them a scene" })),
        demote_criticals: many(7, "stale"),
        director_notes: many(8, "note"),
        voice_patterns: many(9, "pattern"),
        arc_override: {
          arc_name: "the overlong shift",
          transition_signal: "the shift ends",
          dna_shifts: Array.from({ length: 9 }, (_, i) => ({
            axis: i === 0 ? "darkness" : `axis_${i}`,
            value: i === 0 ? 99 : 5,
          })),
          composition_shifts: many(6, "framing").map((axis) => ({ axis, value: "falling" })),
        },
      }) as never,
    );

    const output = await runDirectorCycle(db, campaignId, 8);

    // The cycle survived and every ceiling held.
    expect(output.tension_level).toBe(1);
    expect(output.scene_shape_notes).toHaveLength(3);
    expect(output.arc_relevance).toHaveLength(6);
    expect(output.seed_ops).toHaveLength(6);
    expect(output.spotlight_directives).toHaveLength(3);
    expect(output.demote_criticals).toHaveLength(5);
    expect(output.director_notes).toHaveLength(5);
    expect(output.voice_patterns).toHaveLength(5);
    expect(output.arc_override?.dna_shifts).toHaveLength(6);
    expect(output.arc_override?.composition_shifts).toHaveLength(4);
    // Out-of-band NUMBERS pin rather than drop: a 99 passed through would fail
    // PartialDNAScales and take every other shift in the override with it.
    expect(output.arc_override?.dna_shifts[0]).toEqual({ axis: "darkness", value: 10 });
    expect(output.arc_relevance[0]?.relevance).toBe(9);

    // …and the APPLY ran on the clamped plan, not on nothing.
    expect(vi.mocked(seeds.plantSeed)).toHaveBeenCalledTimes(6);
    const state = await loadDirectionState(db, campaignId);
    expect(state.last_director_turn).toBe(8);
    expect(state.tension_level).toBe(1);
    expect(state.director_notes).toHaveLength(5);
    const [c] = await db
      .select({ arcOverride: schema.campaigns.arcOverride })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(ArcOverride.parse(c?.arcOverride).dna).toEqual({ darkness: 10 });
    warn.mockRestore();
  });

  it("clears an active arc_override on clear_override", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      arcOverride: { arc_name: "prior", started_turn: 2, transition_signal: "the door opens" },
    });
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    mockJudgment.mockResolvedValue(directorOutput({ clear_override: true }) as never);

    await runDirectorCycle(db, campaignId, 8);

    const [c] = await db
      .select({ arcOverride: schema.campaigns.arcOverride })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(c?.arcOverride).toBeNull();
  });

  // --- M2R3: the player-driven drift exit (steering honesty + evolution) -----

  const playerDrivenState = () => ({
    sakkan: {
      last_sample_turn: 16,
      readings: {},
      active_notes: [],
      player_driven: {
        darkness: {
          axis: "darkness",
          observed: 8,
          wanted: 3,
          evidence: "the player kept the whole run one long grim evening",
          at_turn: 16,
        },
      },
    },
  });

  it("dossier carries the player-driven drift as a first-class steering-honesty section", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    await db
      .update(schema.campaigns)
      .set({ directionState: playerDrivenState() })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(directorOutput() as never);
    await runDirectorCycle(db, campaignId, 20);

    const dossier = String((mockJudgment.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? "");
    expect(dossier).toContain("## Player-driven drift");
    expect(dossier).toContain("darkness");
    // The section INSTRUCTS the Director it MAY evolve via an arc_override.
    expect(dossier).toContain("arc_override");
    // Blindness is scoped to the Sakkan's scorer, never the Director: the set
    // value is present here so the showrunner can judge the gap.
    expect(dossier).toContain("premise's 3/10");
  });

  it("an override answering a player-driven drift raises the notice and clears the finding", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    await db
      .update(schema.campaigns)
      .set({ directionState: playerDrivenState() })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(
      directorOutput({
        arc_override: {
          arc_name: "the long evening",
          transition_signal: "dawn breaks over the docks and the case finally closes",
          dna_shifts: [{ axis: "darkness", value: 8 }],
          composition_shifts: [],
        },
      }) as never,
    );

    await runDirectorCycle(db, campaignId, 20);

    const state = await loadDirectionState(db, campaignId);
    // The notice is raised, naming where play RAN vs what the premise SET.
    expect(state.steering_notice).toMatchObject({
      axis: "darkness",
      observed: 8,
      set: 3,
      at_turn: 20,
    });
    // The answered finding cleared — the drift is now led with, not measured
    // against (the next Sakkan sample reads it in band vs the new effective).
    expect(state.sakkan?.player_driven).toEqual({});
    // The evolution rode the EXISTING §4.2 override machinery (reuse, not invent).
    const [c] = await db
      .select({ arcOverride: schema.campaigns.arcOverride })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(ArcOverride.parse(c?.arcOverride).dna).toEqual({ darkness: 8 });
  });

  it("an override on an UNRELATED axis leaves the finding and raises no notice", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    await db
      .update(schema.campaigns)
      .set({ directionState: playerDrivenState() })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(
      directorOutput({
        arc_override: {
          arc_name: "a tonal turn elsewhere",
          transition_signal: "the shuttle clears the gate",
          dna_shifts: [{ axis: "optimism", value: 2 }],
          composition_shifts: [],
        },
      }) as never,
    );

    await runDirectorCycle(db, campaignId, 20);

    const state = await loadDirectionState(db, campaignId);
    expect(state.steering_notice).toBeUndefined();
    // The unanswered finding survives to the next dossier (the Director judged
    // not to evolve THIS axis — the invitation stands, it is never forced).
    expect(state.sakkan?.player_driven.darkness).toBeDefined();
  });

  // --- M3 C4: §7.1 season-boundary evolution ratification --------------------

  /** A season's worth of sustained, player-charged drift on darkness (active 7). */
  const evolutionEvidence = () => ({
    sakkan: {
      last_sample_turn: 44,
      readings: {
        darkness: {
          observed: 10,
          confidence: 0.85,
          at_turn: 44,
          consecutive_drift: 5,
          evidence: "the whole cour ran at night",
        },
      },
      active_notes: [],
      player_driven: {
        darkness: {
          axis: "darkness",
          observed: 10,
          wanted: 7,
          evidence: "the player kept choosing the crueler read",
          at_turn: 30,
        },
      },
    },
  });

  const EVOLUTION_SEASON = {
    seasonId: "season-1",
    name: "Season 1",
    consumed: 12,
    target: 12,
    reason: "budget_reached" as const,
  };

  const proposalOutput = () =>
    directorOutput({
      evolution_proposal: {
        director_case:
          "We set out to make a caper and we have been making a wake. I think the wake is the better show — should that become what we are making?",
        axes: [{ axis: "darkness", to: 10 }],
      },
    }) as never;

  it("mid-season: no EVOLUTION REVIEW section, and a proposal emitted anyway is DROPPED", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    // Evidence is overwhelming — but the season is mid-run, so the gate is shut.
    await db
      .update(schema.campaigns)
      .set({ directionState: evolutionEvidence() })
      .where(eq(schema.campaigns.id, campaignId));
    vi.mocked(arcs.seasonBoundary).mockResolvedValue(null);

    mockJudgment.mockResolvedValue(proposalOutput());
    await runDirectorCycle(db, campaignId, 46);

    const dossier = String((mockJudgment.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? "");
    expect(dossier).not.toContain("EVOLUTION REVIEW");
    // The pinned negative: no gate, no card — never an anxious check-in (§7.1).
    const state = await loadDirectionState(db, campaignId);
    expect(state.evolution_proposal).toBeUndefined();
  });

  it("a season boundary with thin evidence still produces no section (the pinned negative)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    vi.mocked(arcs.seasonBoundary).mockResolvedValue(EVOLUTION_SEASON);
    // One axis, charged to the player, but only two drifting samples — the
    // drift band's own bar, one sample short of a retooling's.
    await db
      .update(schema.campaigns)
      .set({
        directionState: {
          sakkan: {
            last_sample_turn: 44,
            readings: {
              darkness: {
                observed: 10,
                confidence: 0.85,
                at_turn: 44,
                consecutive_drift: 2,
                evidence: "e",
              },
            },
            active_notes: [],
            player_driven: {
              darkness: { axis: "darkness", observed: 10, wanted: 7, evidence: "e", at_turn: 40 },
            },
          },
        },
      })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(directorOutput() as never);
    await runDirectorCycle(db, campaignId, 46);

    const dossier = String((mockJudgment.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? "");
    expect(dossier).not.toContain("EVOLUTION REVIEW");
  });

  it("at the boundary with material evidence: the section renders and the proposal LANDS, amending nothing", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    vi.mocked(arcs.seasonBoundary).mockResolvedValue(EVOLUTION_SEASON);
    await db
      .update(schema.campaigns)
      .set({ directionState: evolutionEvidence() })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(proposalOutput());
    await runDirectorCycle(db, campaignId, 46);

    const dossier = String((mockJudgment.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? "");
    expect(dossier).toContain("EVOLUTION REVIEW");
    expect(dossier).toContain("Season 1");

    const state = await loadDirectionState(db, campaignId);
    expect(state.evolution_proposal).toMatchObject({
      season_id: "season-1",
      proposed_at_turn: 46,
      axes: [{ axis: "darkness", from: 7, to: 10 }],
    });
    expect(state.evolution_proposal?.director_case).toContain("the better show");

    // It AMENDS NOTHING here: the active premise is untouched until the player
    // answers, and no arc_override was minted on its behalf.
    const [c] = await db
      .select({
        premiseContract: schema.campaigns.premiseContract,
        arcOverride: schema.campaigns.arcOverride,
      })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const contract = c?.premiseContract as { active: { treatment: { darkness: number } } };
    expect(contract.active.treatment.darkness).toBe(7);
    expect(c?.arcOverride).toBeNull();
  });

  it("a pending proposal suppresses the ask and survives the cycle untouched (silence persists)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    vi.mocked(arcs.getActiveArc).mockResolvedValue(fakeArc(campaignId));
    vi.mocked(arcs.seasonBoundary).mockResolvedValue(EVOLUTION_SEASON);
    const pending = {
      season_id: "season-1",
      season_name: "Season 1",
      proposed_at_turn: 44,
      director_case: "the case already put to the player",
      axes: [{ axis: "darkness", from: 7, to: 10 }],
    };
    await db
      .update(schema.campaigns)
      .set({ directionState: { ...evolutionEvidence(), evolution_proposal: pending } })
      .where(eq(schema.campaigns.id, campaignId));

    mockJudgment.mockResolvedValue(proposalOutput());
    await runDirectorCycle(db, campaignId, 48);

    const dossier = String((mockJudgment.mock.calls[0]?.[1] as { prompt?: string })?.prompt ?? "");
    // Asking twice while the card is up IS the anxious check-in.
    expect(dossier).not.toContain("EVOLUTION REVIEW");
    const state = await loadDirectionState(db, campaignId);
    expect(state.evolution_proposal).toMatchObject(pending);
  });

  it("startup ensures the scaffold, plans the first arc, and writes the PilotPlan verbatim", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({ openingPackage: ospFixture() });
    vi.mocked(arcs.applyArcPlan).mockResolvedValue({ arcId: "arc-open", phaseChanged: true });

    mockJudgment.mockResolvedValue({
      arc: {
        name: "Pilot: The Ganymede Job",
        dramatic_question: "Do they collect, or does it collect them?",
        shape: "fragmented",
        budget: { unit: "episodes", target: 3, tolerance: 1 },
        phase: "setup",
        payoff_contract: [],
        status: "active",
      },
      cold_open_constraints: ["open in motion", "no origin monologue"],
      scene_shape_notes: ["cold, blue, jazz under everything"],
    } as never);

    await directorStartup(db, campaignId);

    expect(vi.mocked(arcs.ensureSeriesScaffold)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(arcs.budgetPriorFor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(arcs.applyArcPlan)).toHaveBeenCalledWith(
      expect.anything(),
      campaignId,
      0,
      expect.objectContaining({ name: "Pilot: The Ganymede Job" }),
    );

    // No tools on the startup call (planning from the OSP, not investigating).
    const startupOpts = mockJudgment.mock.calls[0]?.[1];
    expect(startupOpts?.tools).toBeUndefined();
    // And no breakpoint: a single-shot head is written once and never re-read.
    expect(startupOpts?.cacheHead).toBeUndefined();

    const state = await loadDirectionState(db, campaignId);
    expect(state.tension_level).toBe(0.2);
    expect(state.phase_state).toEqual({ arc_id: "arc-open", phase: "setup", entered_at_turn: 0 });
    // Forbidden moves passed through VERBATIM from the OSP, never model-rewritten.
    expect(state.pilot_plan?.forbidden_opening_moves).toEqual(FORBIDDEN);
    expect(state.pilot_plan?.opening_pov).toBe("Spike Spiegel");
    expect(state.pilot_plan?.cold_open_constraints).toEqual([
      "open in motion",
      "no origin monologue",
    ]);
    expect(state.pilot_plan?.consumed).toBe(false);
    expect(state.pilot_plan?.first_arc_question).toBe("Do they collect, or does it collect them?");
  });
});
