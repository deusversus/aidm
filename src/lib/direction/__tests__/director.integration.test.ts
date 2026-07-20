import * as schema from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
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
}));
vi.mock("@/lib/direction/seeds", () => ({
  plantSeed: vi.fn(),
  settleSeed: vi.fn(),
  callbackReadySeeds: vi.fn(),
  overdueSeeds: vi.fn(),
  overdueTensionBump: vi.fn(),
  seedDossier: vi.fn(),
}));

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

    // Seed a real critical fact the Director will demote (never delete).
    await db.insert(schema.criticalFacts).values({
      campaignId,
      content: "The safe combination is 4021.",
      category: "sz_fact",
      turnId: 1,
      provenance: "sz_handoff",
      confidence: 1,
    });
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
    expect(callOpts?.maxTokens).toBe(16_000);

    // M2R R2: the dossier carries the Series contract — finitude's behavioral
    // consumer (§8) plus the series-horizon line (the budget's reader).
    const dossierPrompt = String((callOpts as { prompt?: string })?.prompt ?? "");
    expect(dossierPrompt).toContain("## Series contract");
    expect(dossierPrompt).toContain("FINITE");
    expect(dossierPrompt).toContain("planned finale across seasons");
    expect(dossierPrompt).toContain("Series horizon: ~24 episodes, ± 12.");

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

    // The critical fact was demoted, not deleted.
    const [crit] = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(crit).toBeDefined();
    expect(crit?.demotedAt).not.toBeNull();

    // seed ops forwarded.
    expect(vi.mocked(seeds.plantSeed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(seeds.settleSeed)).toHaveBeenCalledTimes(1);

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
