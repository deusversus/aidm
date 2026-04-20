import { type Table, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AidmToolContext } from "../../index";

/**
 * Per-tool unit tests for the 13 Chronicler write tools. Covers:
 *   - Zod input schema catches malformed args
 *   - execute() issues the right DB action (insert/update/select) with
 *     the expected values
 *   - Zod output schema catches malformed returns from the DB layer
 *
 * We don't exercise real Postgres here — registry auth + span wrapping
 * are covered by `src/lib/tools/__tests__/registry.test.ts`, and the
 * real DB round-trip is exercised by the turn-pipeline integration at
 * Commit 7.4 when Chronicler is wired via `after()`.
 *
 * NOTE: `tests/setup.ts` runs `vi.resetModules()` in `beforeEach`, so we
 * dynamic-import the registry per test. A top-level `import { invokeTool }`
 * would bind to a pre-reset module whose registry is empty at test time.
 * Same pattern as `registry.test.ts`'s "real tools" describe.
 */

const UUID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-9222-222222222222";
const NPC_ID = "33333333-3333-4333-8333-333333333333";

interface Captured {
  inserts: Array<{ table: string; values: unknown }>;
  updates: Array<{ table: string; patch: unknown }>;
  conflictTargets: unknown[];
}

async function freshRegistry() {
  return await import("../../index");
}

function fakeDb(
  captured: Captured,
  opts: {
    authRow?: Record<string, unknown>;
    selectQueueAfterAuth?: unknown[][];
    insertReturning?: unknown[];
    updateReturning?: unknown[];
  } = {},
): AidmToolContext["db"] {
  const authRow = opts.authRow ?? {
    id: CAMPAIGN,
    userId: "u-1",
    name: "test",
    settings: {},
  };
  const queue = opts.selectQueueAfterAuth ?? [];

  let selectCall = 0;
  const resolveSelect = async () => {
    // First select hits authorizeCampaignAccess.
    if (selectCall === 0) {
      selectCall += 1;
      return [authRow];
    }
    const next = queue[selectCall - 1] ?? [];
    selectCall += 1;
    return next;
  };

  const tableNameOf = (t: unknown): string => {
    try {
      return getTableName(t as Table);
    } catch {
      return "unknown";
    }
  };

  // Drizzle query builders are thenables — you can `await` them at any
  // step past `.from()`. Our fake mirrors that: every chain method
  // returns an object that *also* acts as a Promise resolving to the
  // canned select rows. Multi-level chains like
  // `select().from().where().orderBy()` await-resolve without a
  // trailing `.limit()`.
  const makeSelectChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const settle = () => resolveSelect();
    // Intentional `then` property — this fake mimics Drizzle's query
    // builder, which is itself a thenable. Biome's noThenProperty is
    // about preventing accidental Promise-like objects; here we want
    // the thenable behavior.
    // biome-ignore lint/suspicious/noThenProperty: fake mirrors Drizzle's thenable builder
    chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
      settle().then(resolve, reject);
    chain.catch = (reject: (err: unknown) => unknown) => settle().catch(reject);
    chain.finally = (cb: () => void) => settle().finally(cb);
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    return chain;
  };

  const makeInsertChain = (tableName: string) => ({
    values: (v: unknown) => {
      captured.inserts.push({ table: tableName, values: v });
      const returning = async () => opts.insertReturning ?? [];
      return {
        returning,
        onConflictDoNothing: (args?: unknown) => {
          if (args) captured.conflictTargets.push({ kind: "doNothing", args });
          return { returning };
        },
        onConflictDoUpdate: (args?: unknown) => {
          if (args) captured.conflictTargets.push({ kind: "doUpdate", args });
          return { returning };
        },
      };
    },
  });

  return {
    select: () => makeSelectChain(),
    insert: (table: unknown) => makeInsertChain(tableNameOf(table)),
    update: (table: unknown) => ({
      set: (patch: unknown) => {
        captured.updates.push({ table: tableNameOf(table), patch });
        return {
          where: () => ({
            returning: async () => opts.updateReturning ?? [],
          }),
        };
      },
    }),
  } as unknown as AidmToolContext["db"];
}

function makeCaptured(): Captured {
  return { inserts: [], updates: [], conflictTargets: [] };
}

function makeCtx(db: AidmToolContext["db"]): AidmToolContext {
  return { campaignId: CAMPAIGN, userId: "u-1", db };
}

describe("Chronicler tools", () => {
  describe("register_npc", () => {
    it("inserts with defaults when fields are omitted; returns created=true", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "register_npc",
        { name: "Jet Black", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, created: true });
      expect(captured.inserts[0]?.table).toBe("npcs");
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.campaignId).toBe(CAMPAIGN);
      expect(v.name).toBe("Jet Black");
      expect(v.role).toBe("acquaintance");
      expect(v.powerTier).toBe("T10");
      expect(v.goals).toEqual([]);
      expect(v.knowledgeTopics).toEqual({});
    });

    it("returns created=false + existing id on unique-conflict", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, {
        insertReturning: [],
        selectQueueAfterAuth: [[{ id: UUID }]],
      });
      const out = await mod.invokeTool(
        "register_npc",
        { name: "Jet Black", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, created: false });
    });

    it("rejects empty name (Zod)", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(
        mod.invokeTool(
          "register_npc",
          { name: "", first_seen_turn: 1, last_seen_turn: 1 },
          makeCtx(db),
        ),
      ).rejects.toThrow();
    });
  });

  describe("update_npc", () => {
    it("updates fields by id; omitted fields untouched", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { updateReturning: [{ id: NPC_ID }] });
      const out = await mod.invokeTool(
        "update_npc",
        { id: NPC_ID, personality: "calm, measured", last_seen_turn: 14 },
        makeCtx(db),
      );
      expect(out).toEqual({ id: NPC_ID, updated: true });
      const patch = captured.updates[0]?.patch as Record<string, unknown>;
      expect(patch.personality).toBe("calm, measured");
      expect(patch.lastSeenTurn).toBe(14);
      expect(patch).toHaveProperty("updatedAt");
      expect(Object.keys(patch).sort()).toEqual(["lastSeenTurn", "personality", "updatedAt"]);
    });

    it("requires id or name (Zod refinement)", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(mod.invokeTool("update_npc", { role: "ally" }, makeCtx(db))).rejects.toThrow();
    });

    it("throws when no row matched", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured(), { updateReturning: [] });
      await expect(
        mod.invokeTool("update_npc", { id: NPC_ID, role: "ally" }, makeCtx(db)),
      ).rejects.toThrow(/no NPC found/i);
    });
  });

  describe("register_location + register_faction", () => {
    it("register_location inserts with default details + created=true", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "register_location",
        { name: "The Bebop", first_seen_turn: 1, last_seen_turn: 1 },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, created: true });
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.details).toEqual({});
    });

    it("register_faction no-ops on conflict and returns existing id", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, {
        insertReturning: [],
        selectQueueAfterAuth: [[{ id: UUID }]],
      });
      const out = await mod.invokeTool(
        "register_faction",
        { name: "Red Dragon Syndicate" },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, created: false });
    });
  });

  describe("record_relationship_event", () => {
    it("appends with npc_id + milestone_type + evidence + turn_number", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "record_relationship_event",
        {
          npc_id: NPC_ID,
          milestone_type: "first_vulnerability",
          evidence: "Jet let Spike see the photo of his ex.",
          turn_number: 12,
        },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID });
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.campaignId).toBe(CAMPAIGN);
      expect(v.npcId).toBe(NPC_ID);
      expect(v.milestoneType).toBe("first_vulnerability");
      expect(v.turnNumber).toBe(12);
    });

    it("rejects empty milestone_type", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(
        mod.invokeTool(
          "record_relationship_event",
          { npc_id: NPC_ID, milestone_type: "", evidence: "x", turn_number: 1 },
          makeCtx(db),
        ),
      ).rejects.toThrow();
    });
  });

  describe("write_semantic_memory", () => {
    it("inserts with default heat 50 and null embedding", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      await mod.invokeTool(
        "write_semantic_memory",
        { category: "relationship", content: "Spike owes Jet gas money.", turn_number: 8 },
        makeCtx(db),
      );
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.heat).toBe(50);
      expect("embedding" in v).toBe(false); // null by column default
    });

    it("clamps heat to [0, 100]", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(
        mod.invokeTool(
          "write_semantic_memory",
          { category: "x", content: "x", heat: 150, turn_number: 1 },
          makeCtx(db),
        ),
      ).rejects.toThrow();
    });
  });

  describe("write_episodic_summary", () => {
    it("updates turns.summary by campaign + turn_number", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { updateReturning: [{ turnNumber: 5 }] });
      const out = await mod.invokeTool(
        "write_episodic_summary",
        { turn_number: 5, summary: "Jet told the story of his ex-partner." },
        makeCtx(db),
      );
      expect(out).toEqual({ turn_number: 5, updated: true });
      const patch = captured.updates[0]?.patch as Record<string, unknown>;
      expect(patch.summary).toBe("Jet told the story of his ex-partner.");
    });

    it("throws when the turn row does not exist", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured(), { updateReturning: [] });
      await expect(
        mod.invokeTool("write_episodic_summary", { turn_number: 99, summary: "x" }, makeCtx(db)),
      ).rejects.toThrow(/no turn row/i);
    });
  });

  describe("plant_foreshadowing_candidate", () => {
    it("inserts with status PLANTED and returns id + literal status", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "plant_foreshadowing_candidate",
        {
          name: "Faye's mystery tape",
          description: "A Beta tape she hasn't watched.",
          payoff_window_min: 5,
          payoff_window_max: 20,
          planted_turn: 2,
        },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, status: "PLANTED" });
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.status).toBe("PLANTED");
      expect(v.dependsOn).toEqual([]);
      expect(v.conflictsWith).toEqual([]);
    });
  });

  describe("plant_foreshadowing_seed (KA path, upgraded from stub)", () => {
    it("inserts real row and returns seed_id + status PLANTED", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "plant_foreshadowing_seed",
        {
          name: "Vicious's call",
          description: "A phone call Spike didn't pick up.",
          payoff_window_min: 3,
          payoff_window_max: 10,
          planted_turn: 4,
        },
        makeCtx(db),
      );
      expect(out).toEqual({ seed_id: UUID, status: "PLANTED" });
      expect(captured.inserts[0]?.table).toBe("foreshadowing_seeds");
    });
  });

  describe("update_arc_plan", () => {
    it("appends arc-plan snapshot with tension formatted to 2dp", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, {
        insertReturning: [{ id: UUID, setAtTurn: 15 }],
      });
      const out = await mod.invokeTool(
        "update_arc_plan",
        {
          current_arc: "Syndicate closing in",
          arc_phase: "complication",
          arc_mode: "main_arc",
          planned_beats: ["Faye picks up a lead", "Jet warns Spike"],
          tension_level: 0.75,
          set_at_turn: 15,
        },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID, set_at_turn: 15 });
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.tensionLevel).toBe("0.75");
      expect(v.plannedBeats).toEqual(["Faye picks up a lead", "Jet warns Spike"]);
    });

    it("rejects invalid arc_phase", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(
        mod.invokeTool(
          "update_arc_plan",
          {
            current_arc: "x",
            arc_phase: "nonsense",
            arc_mode: "main_arc",
            tension_level: 0.5,
            set_at_turn: 1,
          },
          makeCtx(db),
        ),
      ).rejects.toThrow();
    });
  });

  describe("update_voice_patterns", () => {
    it("appends a pattern row", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      const out = await mod.invokeTool(
        "update_voice_patterns",
        { pattern: "terse openings land well", turn_observed: 5 },
        makeCtx(db),
      );
      expect(out).toEqual({ id: UUID });
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.pattern).toBe("terse openings land well");
      expect(v.evidence).toBe(""); // default
    });
  });

  describe("write_director_note", () => {
    it("defaults scope to session", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, { insertReturning: [{ id: UUID }] });
      await mod.invokeTool(
        "write_director_note",
        { content: "Keep Faye in the frame.", created_at_turn: 3 },
        makeCtx(db),
      );
      const v = captured.inserts[0]?.values as Record<string, unknown>;
      expect(v.scope).toBe("session");
    });

    it("rejects invalid scope", async () => {
      const mod = await freshRegistry();
      const db = fakeDb(makeCaptured());
      await expect(
        mod.invokeTool(
          "write_director_note",
          { content: "x", scope: "bogus", created_at_turn: 1 },
          makeCtx(db),
        ),
      ).rejects.toThrow();
    });
  });

  describe("adjust_spotlight_debt", () => {
    it("upserts on (campaign, npc) with SQL-expression delta", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, {
        insertReturning: [{ npcId: NPC_ID, debt: -3 }],
      });
      const out = await mod.invokeTool(
        "adjust_spotlight_debt",
        { npc_id: NPC_ID, delta: -1, updated_at_turn: 10 },
        makeCtx(db),
      );
      expect(out).toEqual({ npc_id: NPC_ID, debt: -3 });
      expect(captured.conflictTargets[0]).toMatchObject({ kind: "doUpdate" });
    });
  });

  describe("trigger_compactor", () => {
    it("returns turn_count + should_compact=false + empty oldest when below threshold", async () => {
      const mod = await freshRegistry();
      const captured = makeCaptured();
      const db = fakeDb(captured, {
        selectQueueAfterAuth: [
          [
            { turnNumber: 1, narrativeText: "scene 1", summary: "s1" },
            { turnNumber: 2, narrativeText: "scene 2", summary: null },
            { turnNumber: 3, narrativeText: "scene 3", summary: null },
          ],
        ],
      });
      const out = await mod.invokeTool("trigger_compactor", {}, makeCtx(db));
      expect(out).toMatchObject({
        turn_count: 3,
        threshold: 20,
        should_compact: false,
        oldest_turns: [],
      });
    });

    it("returns oldest N turn narratives when above threshold", async () => {
      const mod = await freshRegistry();
      const rows = Array.from({ length: 25 }, (_, i) => ({
        turnNumber: i + 1,
        narrativeText: `scene ${i + 1}`,
        summary: i % 2 === 0 ? `s${i + 1}` : null,
      }));
      const captured = makeCaptured();
      const db = fakeDb(captured, { selectQueueAfterAuth: [rows] });
      const out = (await mod.invokeTool(
        "trigger_compactor",
        { threshold: 20, compact_count: 5 },
        makeCtx(db),
      )) as { should_compact: boolean; oldest_turns: Array<{ turn_number: number }> };
      expect(out.should_compact).toBe(true);
      expect(out.oldest_turns.map((t) => t.turn_number)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
