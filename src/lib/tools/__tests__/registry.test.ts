import { type campaigns, campaigns as campaignsTable } from "@/lib/state/schema";
import { type Table, getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AidmAuthError,
  type AidmToolContext,
  authorizeCampaignAccess,
  clearRegistryForTesting,
  invokeTool,
  listTools,
  listToolsByLayer,
  registerTool,
} from "../index";

/**
 * These tests validate the registry infrastructure — auth, schema,
 * span wrapping — using a fake Drizzle client. The point is to prove
 * the infrastructure does the right thing; real DB queries are exercised
 * by tool-specific tests and (at M1) by the turn-pipeline integration.
 */

type FakeRow = Pick<typeof campaigns.$inferSelect, "id" | "userId" | "name" | "settings">;

function fakeDb(rows: FakeRow[]): AidmToolContext["db"] {
  // Table-aware fake: returns the passed `rows` for campaigns lookups
  // (authorizeCampaignAccess), empty arrays for everything else. Tools
  // that actually query their own table (e.g. list_known_npcs) get []
  // instead of the campaign row spuriously matching their schema.
  const tableNameOf = (t: unknown): string => {
    try {
      return getTableName(t as Table);
    } catch {
      return "unknown";
    }
  };
  const rowsFor = (table: unknown): unknown[] => {
    const name = tableNameOf(table);
    if (name === getTableName(campaignsTable)) return rows;
    return [];
  };
  return {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => rowsFor(t),
          orderBy: (_o: unknown) => ({
            limit: async (_n: number) => rowsFor(t),
          }),
        }),
      }),
    }),
  } as unknown as AidmToolContext["db"];
}

function makeCtx(overrides: Partial<AidmToolContext> = {}): AidmToolContext {
  return {
    campaignId: "c-1",
    userId: "u-1",
    db: fakeDb([{ id: "c-1", userId: "u-1", name: "test", settings: {} }]),
    ...overrides,
  };
}

describe("tool registry — core infrastructure", () => {
  describe("registerTool / listTools", () => {
    it("all production tools register when the registry bootstraps", async () => {
      // Importing the index triggers ./all which registers every tool.
      await import("../index");
      const names = listTools().map((t) => t.name);
      expect(names).toEqual(
        [
          // Arc (read + KA write path)
          "get_arc_state",
          "list_active_seeds",
          "plant_foreshadowing_seed",
          "resolve_seed",
          // Chronicler write tools (post-turn archivist)
          "adjust_spotlight_debt",
          "plant_foreshadowing_candidate",
          "ratify_foreshadowing_seed",
          "record_relationship_event",
          "register_faction",
          "register_location",
          "register_npc",
          "retire_foreshadowing_seed",
          "spawn_transient",
          "trigger_compactor",
          "update_arc_plan",
          "update_context_block",
          "update_npc",
          "update_voice_patterns",
          "write_director_note",
          "write_episodic_summary",
          "write_semantic_memory",
          // Critical / Entities / Episodic / Semantic / Voice reads
          "get_character_sheet",
          "get_context_block",
          "get_critical_memories",
          "get_npc_details",
          "get_overrides",
          "get_recent_episodes",
          "get_turn_narrative",
          "get_voice_exemplars_by_beat_type",
          "get_voice_patterns",
          "get_world_state",
          "list_known_npcs",
          "recall_scene",
          "search_memory",
        ].sort(),
      );
    });

    it("listToolsByLayer partitions correctly", async () => {
      await import("../index");
      expect(
        listToolsByLayer("entities")
          .map((t) => t.name)
          .sort(),
      ).toEqual(
        [
          "get_character_sheet",
          "get_context_block",
          "get_npc_details",
          "get_world_state",
          "list_known_npcs",
          // Chronicler write tools on the entities layer
          "record_relationship_event",
          "register_faction",
          "register_location",
          "register_npc",
          "spawn_transient",
          "update_context_block",
          "update_npc",
        ].sort(),
      );
      expect(
        listToolsByLayer("episodic")
          .map((t) => t.name)
          .sort(),
      ).toEqual(
        [
          "get_recent_episodes",
          "get_turn_narrative",
          "recall_scene",
          // Chronicler write + trigger tools on the episodic layer
          "trigger_compactor",
          "write_episodic_summary",
        ].sort(),
      );
      expect(listToolsByLayer("ambient")).toEqual([]);
      expect(listToolsByLayer("working")).toEqual([]);
    });

    it("duplicate registration throws", async () => {
      // Work in a scratch registry — don't pollute the real one.
      clearRegistryForTesting();
      const spec = {
        name: "dup",
        description: "d",
        layer: "entities" as const,
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => ({}),
      };
      registerTool(spec);
      expect(() => registerTool(spec)).toThrow(/duplicate/i);
    });
  });

  describe("authorization", () => {
    beforeEach(() => clearRegistryForTesting());
    afterEach(() => clearRegistryForTesting());

    it("authorizeCampaignAccess resolves when the row exists + belongs to user", async () => {
      const ctx = makeCtx();
      await expect(authorizeCampaignAccess(ctx)).resolves.toMatchObject({
        id: "c-1",
        userId: "u-1",
      });
    });

    it("authorizeCampaignAccess throws AidmAuthError when no row found", async () => {
      const ctx = makeCtx({ db: fakeDb([]) });
      await expect(authorizeCampaignAccess(ctx)).rejects.toBeInstanceOf(AidmAuthError);
    });
  });

  describe("invokeTool", () => {
    beforeEach(() => clearRegistryForTesting());
    afterEach(() => clearRegistryForTesting());

    it("validates input, authorizes, executes, validates output", async () => {
      const executed: unknown[] = [];
      registerTool({
        name: "echo",
        description: "echoes",
        layer: "entities" as const,
        inputSchema: z.object({ v: z.number() }),
        outputSchema: z.object({ v: z.number() }),
        execute: async (input) => {
          executed.push(input);
          return input;
        },
      });
      const out = await invokeTool("echo", { v: 42 }, makeCtx());
      expect(out).toEqual({ v: 42 });
      expect(executed).toEqual([{ v: 42 }]);
    });

    it("throws ZodError on bad input", async () => {
      registerTool({
        name: "echo",
        description: "e",
        layer: "entities" as const,
        inputSchema: z.object({ v: z.number() }),
        outputSchema: z.object({ v: z.number() }),
        execute: async (input) => input,
      });
      await expect(invokeTool("echo", { v: "not-a-number" }, makeCtx())).rejects.toThrow(/number/i);
    });

    it("throws AidmAuthError when campaign does not belong to user", async () => {
      registerTool({
        name: "echo",
        description: "e",
        layer: "entities" as const,
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => ({}),
      });
      const ctx = makeCtx({ db: fakeDb([]) });
      await expect(invokeTool("echo", {}, ctx)).rejects.toBeInstanceOf(AidmAuthError);
    });

    it("throws on unknown tool name", async () => {
      await expect(invokeTool("does-not-exist", {}, makeCtx())).rejects.toThrow(/unknown tool/i);
    });

    it("wraps execute in a Langfuse-compatible span", async () => {
      const spans: Array<{ name: string; endedWith: unknown }> = [];
      const trace = {
        span(opts: { name: string; input?: unknown; metadata?: Record<string, unknown> }) {
          const entry = { name: opts.name, endedWith: undefined as unknown };
          spans.push(entry);
          return {
            end(data?: { output?: unknown; metadata?: Record<string, unknown> }) {
              entry.endedWith = data;
            },
          };
        },
      };
      registerTool({
        name: "echo",
        description: "e",
        layer: "entities" as const,
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      });
      await invokeTool("echo", {}, makeCtx({ trace }));
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe("tool:echo");
      expect(spans[0]?.endedWith).toMatchObject({ output: { ok: true } });
    });

    it("span is ended with error metadata when execute throws", async () => {
      const spans: Array<{ endedWith: unknown }> = [];
      const trace = {
        span() {
          const entry = { endedWith: undefined as unknown };
          spans.push(entry);
          return {
            end(data?: unknown) {
              entry.endedWith = data;
            },
          };
        },
      };
      registerTool({
        name: "boom",
        description: "e",
        layer: "entities" as const,
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => {
          throw new Error("kaboom");
        },
      });
      await expect(invokeTool("boom", {}, makeCtx({ trace }))).rejects.toThrow(/kaboom/);
      expect(spans[0]?.endedWith).toMatchObject({ metadata: { error: "kaboom" } });
    });
  });

  // The "real tools" block exercises the registry after ./all has populated
  // it. Because tests/setup.ts runs vi.resetModules() in beforeEach, we must
  // pull the registry API from a fresh dynamic import inside each test —
  // the top-of-file import binds to a pre-reset module whose registry has
  // been cleared by other describe blocks' hooks.
  describe("real tools", () => {
    it("get_world_state returns default shape when settings lack world_state", async () => {
      const mod = await import("../index");
      const tool = mod.getTool("get_world_state");
      expect(tool).toBeDefined();
      const result = await mod.invokeTool("get_world_state", {}, makeCtx());
      expect(result).toEqual({
        location: null,
        situation: null,
        time_context: null,
        arc_phase: null,
        tension_level: null,
        present_npcs: [],
      });
    });

    it("get_world_state returns populated shape when settings.world_state exists", async () => {
      const mod = await import("../index");
      const ctx = makeCtx({
        db: fakeDb([
          {
            id: "c-1",
            userId: "u-1",
            name: "t",
            settings: {
              world_state: {
                location: "Mars",
                present_npcs: ["Spike", "Faye"],
              },
            },
          },
        ]),
      });
      const result = (await mod.invokeTool("get_world_state", {}, ctx)) as {
        location: string | null;
        present_npcs: string[];
      };
      expect(result.location).toBe("Mars");
      expect(result.present_npcs).toEqual(["Spike", "Faye"]);
    });

    it("get_overrides returns empty array when settings.overrides missing", async () => {
      const mod = await import("../index");
      const result = await mod.invokeTool("get_overrides", {}, makeCtx());
      expect(result).toEqual({ overrides: [] });
    });

    it("get_overrides tolerates malformed entries without throwing", async () => {
      const mod = await import("../index");
      const ctx = makeCtx({
        db: fakeDb([
          {
            id: "c-1",
            userId: "u-1",
            name: "t",
            settings: {
              overrides: [
                // valid
                {
                  id: "o1",
                  category: "NPC_PROTECTION",
                  value: "Lloyd cannot die",
                  scope: "campaign",
                  created_at: "2026-04-19T00:00:00Z",
                },
                // malformed — missing fields
                { id: "o2" },
                // malformed — wrong enum
                {
                  id: "o3",
                  category: "NONSENSE",
                  value: "x",
                  created_at: "2026-04-19T00:00:00Z",
                },
              ],
            },
          },
        ]),
      });
      const result = (await mod.invokeTool("get_overrides", {}, ctx)) as {
        overrides: Array<{ id: string }>;
      };
      expect(result.overrides.map((o) => o.id)).toEqual(["o1"]);
    });

    it("layers pending their content-producer return well-typed empty shapes", async () => {
      // Tools whose upstream writer hasn't produced data yet (NPC
      // catalog, memory writer, Director journal, foreshadowing
      // ledger). Empty output is the valid state for a live layer with
      // no content yet — not a deferred or missing feature.
      const mod = await import("../index");
      const ctx = makeCtx();
      expect(await mod.invokeTool("list_known_npcs", {}, ctx)).toEqual({ npcs: [] });
      expect(await mod.invokeTool("search_memory", { query: "anything", k: 3 }, ctx)).toEqual({
        memories: [],
      });
      expect(await mod.invokeTool("list_active_seeds", {}, ctx)).toEqual({ seeds: [] });
      expect(await mod.invokeTool("get_arc_state", {}, ctx)).toMatchObject({
        available: false,
        planned_beats: [],
      });
      expect(await mod.invokeTool("get_voice_patterns", {}, ctx)).toEqual({ patterns: [] });
    });

    it("get_character_sheet returns available:false when no character row exists", async () => {
      const mod = await import("../index");
      // Auth lookup returns the campaign row; character query returns
      // empty. The generic fakeDb returns the same rows for every
      // query, so we hand-craft a two-response fake here.
      let call = 0;
      const ctx = {
        ...makeCtx(),
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => {
                  call += 1;
                  // Call 1: authorizeCampaignAccess → campaign row exists
                  if (call === 1) {
                    return [{ id: "c-1", userId: "u-1", name: "test", settings: {} }];
                  }
                  // Call 2: get_character_sheet → no character row
                  return [];
                },
              }),
            }),
          }),
        } as unknown as AidmToolContext["db"],
      };
      const result = (await mod.invokeTool("get_character_sheet", {}, ctx)) as {
        available: boolean;
        name: string | null;
      };
      expect(result.available).toBe(false);
      expect(result.name).toBeNull();
    });
  });
});
