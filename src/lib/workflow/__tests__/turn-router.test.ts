import type { Db } from "@/lib/db";
import type { IntentOutput } from "@/lib/types/turn";
import { type Table, getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * turn-router.test.ts — short-circuit persistence (Phase 1, v3-audit
 * closure). Validates the bind-state paths the original implementation
 * was missing:
 *
 *   - /override → campaign.settings.overrides append
 *   - WB-ACCEPT entityUpdates → Chronicler write tools invoked
 *
 * These tests drive runTurn with a stubbed routePlayerMessage (via the
 * `routeFn` dep) so we don't have to mock three sub-agents + two
 * structured-runner providers to get a deterministic verdict shape.
 *
 * `invokeTool` is mocked at the module level so WB-ACCEPT tests can
 * assert which tools fired + with what inputs, without requiring real DB
 * round-trips through the tool registry.
 */

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-1";
const PROFILE_SLUG = "cowboy-bebop";

// ---------------------------------------------------------------------------
// Module-level mock for invokeTool — must appear before the import below.
// ---------------------------------------------------------------------------
vi.mock("@/lib/tools", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tools")>("@/lib/tools");
  return {
    ...actual,
    invokeTool: vi.fn(async () => ({ id: "fake-id", created: true })),
  };
});

// Profile fixture that satisfies Profile.parse with minimal shape.
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

// ---------------------------------------------------------------------------
// Fake Db with write tracking.
// ---------------------------------------------------------------------------
interface DbTrace {
  insertValues: Array<{ table: string; values: unknown }>;
  updateCalls: Array<{ table: string; patch: unknown }>;
  selectTable: string[];
  executeCalls: number;
}

function fakeDb(trace: DbTrace): Db {
  const nameOf = (t: unknown): string => {
    try {
      return getTableName(t as Table);
    } catch {
      return "unknown";
    }
  };
  return {
    execute: async () => {
      trace.executeCalls += 1;
      // pg_try_advisory_lock → locked: true so the workflow proceeds.
      return { rows: [{ locked: true }] };
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        const name = nameOf(table);
        trace.selectTable.push(name);
        return {
          where: (_w?: unknown) => ({
            limit: async () => {
              if (name === "campaigns") {
                return [
                  {
                    id: CAMPAIGN_ID,
                    userId: USER_ID,
                    name: "Test Campaign",
                    phase: "playing",
                    profileRefs: [PROFILE_SLUG],
                    settings: { overrides: [] },
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
            orderBy: (_o?: unknown) => ({
              limit: async () => [], // working-memory query
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
    update: (table: unknown) => {
      const name = nameOf(table);
      return {
        set: (patch: unknown) => {
          trace.updateCalls.push({ table: name, patch });
          return {
            where: async () => ({ rowCount: 1 }),
          };
        },
      };
    },
  } as unknown as Db;
}

function makeTrace(): DbTrace {
  return { insertValues: [], updateCalls: [], selectTable: [], executeCalls: 0 };
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

describe("runTurn — /override persistence (Phase 1, v3-audit closure)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("appends a new override entry to campaign.settings.overrides on ACK", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "NPC_PROTECTION" as const,
        value: "Jet cannot die",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Noted. Jet is protected.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/override Jet cannot die" },
      { db, routeFn },
    );
    const events: string[] = [];
    for await (const ev of iter) {
      events.push(ev.type);
    }
    expect(events).toContain("routed");
    expect(events).toContain("done");

    // campaigns.update fired with the new override appended.
    const campaignUpdates = trace.updateCalls.filter((u) => u.table === "campaigns");
    expect(campaignUpdates).toHaveLength(1);
    const patch = campaignUpdates[0]?.patch as { settings: { overrides: unknown[] } };
    expect(patch.settings.overrides).toHaveLength(1);
    const [newOverride] = patch.settings.overrides as Array<{
      id: string;
      category: string;
      value: string;
      scope: string;
      created_at: string;
    }>;
    expect(newOverride?.category).toBe("NPC_PROTECTION");
    expect(newOverride?.value).toBe("Jet cannot die");
    expect(newOverride?.scope).toBe("campaign");
    expect(newOverride?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("preserves existing overrides and appends new (not clobber)", async () => {
    const trace = makeTrace();
    // Override the fake to return a campaign that already has one override.
    const base = fakeDb(trace);
    const existingOverride = {
      id: "pre-existing",
      category: "TONE_REQUIREMENT",
      value: "No swearing",
      scope: "campaign",
      created_at: "2026-04-20T00:00:00Z",
    };
    const db: Db = {
      ...base,
      select: (cols?: unknown) => {
        const inner = (base as unknown as { select: (c?: unknown) => unknown }).select(cols) as {
          from: (t: unknown) => {
            where: (w?: unknown) => {
              limit: () => Promise<unknown[]>;
              orderBy: (o?: unknown) => unknown;
            };
          };
        };
        return {
          from: (t: unknown) => ({
            where: (w?: unknown) => {
              const inner2 = inner.from(t).where(w);
              return {
                limit: async () => {
                  const rows = await inner2.limit();
                  // Inject existing overrides on the campaign row.
                  if (Array.isArray(rows) && rows.length > 0 && "settings" in (rows[0] as object)) {
                    const row = rows[0] as { settings: { overrides: unknown[] } };
                    if (
                      Array.isArray(row.settings?.overrides) &&
                      row.settings.overrides.length === 0
                    ) {
                      return [{ ...row, settings: { overrides: [existingOverride] } }];
                    }
                  }
                  return rows;
                },
                orderBy: inner2.orderBy,
              };
            },
          }),
        };
      },
    } as unknown as Db;

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "NARRATIVE_DEMAND" as const,
        value: "No combat this session",
        scope: "session" as const,
        conflicts_with: [],
        ack_phrasing: "Heard.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "/override No combat this session",
      },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    const campaignUpdates = trace.updateCalls.filter((u) => u.table === "campaigns");
    expect(campaignUpdates).toHaveLength(1);
    const patch = campaignUpdates[0]?.patch as { settings: { overrides: unknown[] } };
    expect(patch.settings.overrides).toHaveLength(2);
    const ids = (patch.settings.overrides as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain("pre-existing");
  });

  it("next turn's router reads the persisted override back via priorOverrides (v3-parity plan §1.1)", async () => {
    const trace = makeTrace();
    // Shared campaign state across two turns — settings mutates via the
    // override persist path, next turn loads it back.
    const base = fakeDb(trace);
    let sharedSettings: { overrides: unknown[] } = { overrides: [] };
    const db: Db = {
      ...base,
      select: (cols?: unknown) => {
        const inner = (base as unknown as { select: (c?: unknown) => unknown }).select(cols) as {
          from: (t: unknown) => {
            where: (w?: unknown) => {
              limit: () => Promise<unknown[]>;
              orderBy: (o?: unknown) => unknown;
            };
          };
        };
        return {
          from: (t: unknown) => ({
            where: (w?: unknown) => {
              const inner2 = inner.from(t).where(w);
              return {
                limit: async () => {
                  const rows = await inner2.limit();
                  // Inject the live sharedSettings onto the campaign row each select.
                  if (Array.isArray(rows) && rows.length > 0 && "settings" in (rows[0] as object)) {
                    const row = rows[0] as { settings: unknown };
                    return [{ ...row, settings: sharedSettings }];
                  }
                  return rows;
                },
                orderBy: inner2.orderBy,
              };
            },
          }),
        };
      },
      update: (table: unknown) => {
        const name = (() => {
          try {
            return getTableName(table as Table);
          } catch {
            return "unknown";
          }
        })();
        return {
          set: (patch: unknown) => {
            trace.updateCalls.push({ table: name, patch });
            // Mutate the shared settings reference so the NEXT select
            // sees the persisted override.
            if (name === "campaigns") {
              const p = patch as { settings?: { overrides?: unknown[] } };
              if (p.settings) sharedSettings = p.settings as { overrides: unknown[] };
            }
            return { where: async () => ({ rowCount: 1 }) };
          },
        };
      },
    } as unknown as Db;

    const { runTurn } = await import("../turn");

    const firstRouteFn = (async () => ({
      kind: "override" as const,
      intent: makeIntent({ intent: "OVERRIDE_COMMAND" }),
      override: {
        mode: "override" as const,
        category: "CONTENT_CONSTRAINT" as const,
        value: "No explicit violence",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Noted.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/override no violence" },
      { db, routeFn: firstRouteFn },
    )) {
      /* drain */
    }

    // Second turn: router receives priorOverrides populated from first persist.
    let capturedPriorOverrides: unknown[] | undefined;
    const secondRouteFn = (async (input: { priorOverrides?: unknown[] }) => {
      capturedPriorOverrides = input.priorOverrides;
      return {
        kind: "continue" as const,
        intent: makeIntent({ intent: "DEFAULT", epicness: 0.05 }),
      };
    }) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    // Mock runKa to avoid reaching the real Agent SDK.
    const mockRunKa = async function* () {
      yield {
        kind: "final",
        narrative: "nothing happens.",
        ttftMs: null,
        totalMs: 10,
        costUsd: 0,
        sessionId: null,
        stopReason: "end_turn",
      };
    } as unknown as Parameters<typeof runTurn>[1]["runKa"];

    for await (const _ of runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "continue" },
      { db, routeFn: secondRouteFn, runKa: mockRunKa },
    )) {
      /* drain */
    }

    expect(capturedPriorOverrides).toBeDefined();
    expect(capturedPriorOverrides).toHaveLength(1);
    const [o] = capturedPriorOverrides as Array<{ category: string; value: string; scope: string }>;
    expect(o?.category).toBe("CONTENT_CONSTRAINT");
    expect(o?.value).toBe("No explicit violence");
    expect(o?.scope).toBe("campaign");
  });

  it("does not persist when override mode is 'meta' (meta conversation Phase 5)", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "meta" as const,
      intent: makeIntent({ intent: "META_FEEDBACK" }),
      override: {
        mode: "meta" as const,
        category: null,
        value: "I'd like less swearing going forward",
        scope: "campaign" as const,
        conflicts_with: [],
        ack_phrasing: "Heard.",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "/meta less swearing" },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }
    // No campaign update for meta-mode overrides at Phase 1.
    const campaignUpdates = trace.updateCalls.filter((u) => u.table === "campaigns");
    expect(campaignUpdates).toHaveLength(0);
  });
});

describe("runTurn — WB ACCEPT entity persistence (Phase 1, v3-audit closure)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("invokes register_npc for npc entityUpdates", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "ACCEPT" as const,
        response: "Of course — Jet's ISSP past is canon.",
        entityUpdates: [
          {
            kind: "npc" as const,
            name: "Jet Black",
            details: "Former ISSP major; Bebop co-captain",
          },
        ],
        rationale: "player-consistent backstory for Jet",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "Jet is a retired ISSP major",
      },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "register_npc",
      expect.objectContaining({
        name: "Jet Black",
        personality: "Former ISSP major; Bebop co-captain",
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID, userId: USER_ID }),
    );
  });

  it("invokes register_location for location entityUpdates", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "ACCEPT" as const,
        response: "The docking bay is yours.",
        entityUpdates: [
          {
            kind: "location" as const,
            name: "Tharsis Dock 17",
            details: "grimy orbital dock; Red Dragon territory",
          },
        ],
        rationale: "new location grounded in canon",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "I dock at Tharsis 17",
      },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "register_location",
      expect.objectContaining({
        name: "Tharsis Dock 17",
        details: { description: "grimy orbital dock; Red Dragon territory" },
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it("invokes write_semantic_memory with heat 80 for player-asserted facts", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "ACCEPT" as const,
        response: "Established.",
        entityUpdates: [
          {
            kind: "fact" as const,
            name: "Red Dragon debt",
            details: "Spike owes Vicious twelve million woolongs",
          },
        ],
        rationale: "backstory fact",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      {
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        playerMessage: "Spike owes Vicious money",
      },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).toHaveBeenCalledWith(
      "write_semantic_memory",
      expect.objectContaining({
        category: "fact",
        heat: 80,
        content: expect.stringContaining("Red Dragon debt"),
      }),
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });

  it("does NOT invoke any tools on WB CLARIFY (non-ACCEPT)", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "CLARIFY" as const,
        response: "Tell me more about the amulet.",
        entityUpdates: [{ kind: "npc" as const, name: "x", details: "y" }],
        rationale: "needs clarification",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "I pull out my amulet" },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("continues processing remaining updates when one fails", async () => {
    const trace = makeTrace();
    const db = fakeDb(trace);
    const tools = await import("@/lib/tools");
    const invokeSpy = tools.invokeTool as unknown as ReturnType<typeof vi.fn>;
    invokeSpy.mockClear();
    // First call fails, rest succeed.
    invokeSpy.mockImplementationOnce(async () => {
      throw new Error("simulated failure");
    });
    invokeSpy.mockImplementation(async () => ({ id: "fake", created: true }));

    const { runTurn } = await import("../turn");

    const routeFn = (async () => ({
      kind: "worldbuilder" as const,
      intent: makeIntent({ intent: "WORLD_BUILDING" }),
      verdict: {
        decision: "ACCEPT" as const,
        response: "noted.",
        entityUpdates: [
          { kind: "npc" as const, name: "A", details: "a" },
          { kind: "location" as const, name: "B", details: "b" },
          { kind: "fact" as const, name: "C", details: "c" },
        ],
        rationale: "multiple entities",
      },
    })) as unknown as Parameters<typeof runTurn>[1]["routeFn"];

    const iter = runTurn(
      { campaignId: CAMPAIGN_ID, userId: USER_ID, playerMessage: "assert much" },
      { db, routeFn },
    );
    for await (const _ of iter) {
      /* drain */
    }

    // All three were attempted despite first throwing.
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });
});
