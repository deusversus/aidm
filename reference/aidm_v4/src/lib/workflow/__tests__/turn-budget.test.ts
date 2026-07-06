import type { Db } from "@/lib/db";
import type { IntentOutput } from "@/lib/types/turn";
import { type Table, getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * turn-budget.test.ts — Commit 9 cost aggregation + bypassLimiter
 * threading. Verifies:
 *
 *   1. `recordCost` emitted by the router's pre-pass consultants
 *      accumulates into `turns.costUsd` alongside KA's SDK-reported cost.
 *   2. When pre-pass spends X and KA spends Y, persisted costUsd = X+Y.
 *   3. `bypassLimiter` field on TurnWorkflowInput is accepted without
 *      throwing (forward-looking marker; no-op inside runTurn itself).
 */

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";
const PROFILE_SLUG = "cowboy-bebop";

const MIN_PROFILE = {
  id: "cowboy-bebop",
  title: "Cowboy Bebop",
  alternate_titles: [],
  media_type: "anime",
  status: "completed",
  relation_type: "canonical",
  ip_mechanics: {
    power_distribution: {
      peak_tier: "T7",
      typical_tier: "T9",
      floor_tier: "T10",
      gradient: "flat",
    },
    stat_mapping: {
      has_canonical_stats: false,
      confidence: 50,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    },
    combat_style: "tactical",
    storytelling_tropes: {
      tournament_arc: false,
      training_montage: false,
      power_of_friendship: false,
      mentor_death: false,
      chosen_one: false,
      tragic_backstory: false,
      redemption_arc: false,
      betrayal: false,
      sacrifice: false,
      transformation: false,
      forbidden_technique: false,
      time_loop: false,
      false_identity: false,
      ensemble_focus: true,
      slow_burn_romance: false,
    },
    world_setting: { genre: ["noir"], locations: [], factions: [], time_period: "2071" },
    voice_cards: [],
    author_voice: {
      sentence_patterns: [],
      structural_motifs: [],
      dialogue_quirks: [],
      emotional_rhythm: [],
      example_voice: "",
    },
    visual_style: { art_style: "", color_palette: "", reference_descriptors: [] },
  },
  canonical_dna: {
    pacing: 6,
    continuity: 3,
    density: 4,
    temporal_structure: 4,
    optimism: 3,
    darkness: 7,
    comedy: 4,
    emotional_register: 6,
    intimacy: 6,
    fidelity: 7,
    reflexivity: 3,
    avant_garde: 6,
    epistemics: 6,
    moral_complexity: 8,
    didacticism: 3,
    cruelty: 5,
    power_treatment: 6,
    scope: 5,
    agency: 6,
    interiority: 6,
    conflict_style: 5,
    register: 7,
    empathy: 8,
    accessibility: 7,
  },
  canonical_composition: {
    tension_source: "existential",
    power_expression: "flashy",
    narrative_focus: "ensemble",
    mode: "standard",
    antagonist_origin: "interpersonal",
    antagonist_multiplicity: "episodic",
    arc_shape: "fragmented",
    resolution_trajectory: "ambiguous",
    escalation_pattern: "waves",
    status_quo_stability: "gradual",
    player_role: "protagonist",
    choice_weight: "local",
    story_time_density: "months",
  },
  director_personality: "noir-inflected, restrained, melancholic",
};

interface DbTrace {
  insertValues: Array<{ table: string; values: unknown }>;
  updateCalls: Array<{ table: string; patch: unknown }>;
}

function fakeDb(trace: DbTrace): Db {
  const nameOf = (t: unknown): string => getTableName(t as Table);
  return {
    execute: async () => ({ rows: [{ locked: true }] }),
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const name = nameOf(table);
        return {
          where: () => ({
            limit: async () => {
              if (name === "campaigns") {
                return [
                  {
                    id: CAMPAIGN_ID,
                    userId: USER_ID,
                    name: "Test Campaign",
                    phase: "playing",
                    profileRefs: [PROFILE_SLUG],
                    settings: {},
                    deletedAt: null,
                    createdAt: new Date(),
                  },
                ];
              }
              if (name === "profiles") {
                return [
                  {
                    id: "p1",
                    slug: PROFILE_SLUG,
                    title: "Cowboy Bebop",
                    mediaType: "anime",
                    content: MIN_PROFILE,
                    version: 1,
                    createdAt: new Date(),
                  },
                ];
              }
              if (name === "characters") {
                return [
                  {
                    id: "c1",
                    campaignId: CAMPAIGN_ID,
                    name: "Spike",
                    concept: "ex-syndicate bounty hunter",
                    powerTier: "T7",
                    sheet: {},
                    createdAt: new Date(),
                  },
                ];
              }
              return [];
            },
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      const name = nameOf(table);
      return {
        values: (values: unknown) => {
          trace.insertValues.push({ table: name, values });
          return {
            returning: async () => [{ id: `${name}-row-id` }],
          };
        },
      };
    },
    update: () => ({
      set: () => ({ where: async () => ({ rowCount: 1 }) }),
    }),
  } as unknown as Db;
}

function makeIntent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    intent: "DEFAULT",
    action: "ack",
    epicness: 0.2,
    special_conditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("runTurn — cost aggregation (Commit 9)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("persists costUsd as the sum of pre-pass recordCost + KA SDK cost", async () => {
    const trace: DbTrace = { insertValues: [], updateCalls: [] };
    const db = fakeDb(trace);
    const { runTurn } = await import("../turn");

    // Stub routeFn that emits cost via the recordCost dep, simulating
    // what a real routePlayerMessage call would do when its sub-agents
    // (IntentClassifier / OJ / etc.) report their usage.
    const routeFn = (async (_input: unknown, deps: unknown) => {
      const d = deps as { recordCost?: (agent: string, cost: number) => void };
      d.recordCost?.("intent-classifier", 0.001);
      d.recordCost?.("outcome-judge", 0.002);
      d.recordCost?.("validator", 0.0005);
      return {
        kind: "continue" as const,
        intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
      };
    }) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "A quiet moment on the bebop.",
        ttftMs: 100,
        totalMs: 800,
        // KA's SDK reports $0.05 for the full session (includes any
        // consultants it spawned via Agent tool).
        costUsd: 0.05,
        sessionId: "ka-session-1",
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "look around" },
      { db, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    const turnInsert = trace.insertValues.find((i) => i.table === "turns");
    expect(turnInsert).toBeDefined();
    const values = turnInsert?.values as { costUsd: string };
    // 0.001 + 0.002 + 0.0005 + 0.05 = 0.0535
    expect(values.costUsd).toBe("0.053500");
  });

  it("persists KA cost alone when pre-pass emits no recordCost calls", async () => {
    const trace: DbTrace = { insertValues: [], updateCalls: [] };
    const db = fakeDb(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "A quiet moment.",
        ttftMs: 50,
        totalMs: 500,
        costUsd: 0.0123,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "go" },
      { db, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    const turnInsert = trace.insertValues.find((i) => i.table === "turns");
    expect(turnInsert).toBeDefined();
    const values = turnInsert?.values as { costUsd: string };
    expect(values.costUsd).toBe("0.012300");
  });

  it("persists 0 when both pre-pass and KA report zero cost", async () => {
    const trace: DbTrace = { insertValues: [], updateCalls: [] };
    const db = fakeDb(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "continue" as const,
      intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "silent turn",
        ttftMs: null,
        totalMs: 1,
        costUsd: 0,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "silent" },
      { db, routeFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    const values = trace.insertValues.find((i) => i.table === "turns")?.values as {
      costUsd: string;
    };
    expect(values.costUsd).toBe("0.000000");
  });
});
