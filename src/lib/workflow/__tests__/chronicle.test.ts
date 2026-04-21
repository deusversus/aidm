import type { Db } from "@/lib/db";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { type Table, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chronicleTurn, computeArcTrigger } from "../chronicle";

/**
 * chronicleTurn wraps runChronicler with:
 *   - FIFO-per-campaign advisory lock (namespace-separated from turn pipeline)
 *   - idempotency guard on `turns.chronicled_at`
 *   - error swallow (doesn't throw; returns status tag)
 *
 * Tests here validate the wrapper's behavior against a fake DB + a
 * stubbed Agent SDK query. Real Postgres round-trip is an integration
 * target (not in M1 scope; acceptance ritual exercises it end-to-end).
 */

const CAMPAIGN = "22222222-2222-4222-9222-222222222222";
const TURN_ID = "11111111-1111-4111-8111-111111111111";

const intent: IntentOutput = {
  intent: "SOCIAL",
  action: "ask",
  target: "Jet",
  epicness: 0.3,
  special_conditions: [],
  confidence: 0.9,
};

const outcome: OutcomeOutput = {
  success_level: "success",
  difficulty_class: 12,
  modifiers: [],
  narrative_weight: "SIGNIFICANT",
  consequence: "Jet opens up.",
  rationale: "ok",
};

interface DbHooks {
  turnChronicledAt?: Date | null;
  turnExists?: boolean;
  campaignExists?: boolean;
  /** SQL fingerprint per db.execute call. We stringify the `queryChunks` so
   * pg_advisory_lock vs unlock can be distinguished textually. */
  executeCalls: Array<{ chunks: string }>;
  updateCalls: Array<{ patch: unknown }>;
}

/** Render a drizzle `sql` template's queryChunks into a plain string we
 * can match with regex. Drizzle's SQL object exposes `queryChunks` as an
 * array of string parts + embedded SQL/Param instances. We just stringify
 * each element and join — enough for "contains pg_advisory_lock" checks. */
function sqlToText(sqlExpr: unknown): string {
  const obj = sqlExpr as { queryChunks?: unknown[] };
  const chunks = obj.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      // Param objects and nested SQL — show their JSON or String form.
      const p = c as { value?: unknown; queryChunks?: unknown[] };
      if (p.queryChunks) return sqlToText(p);
      if (p.value !== undefined) return String(p.value);
      return JSON.stringify(c);
    })
    .join("");
}

function fakeDb(hooks: DbHooks): Db {
  const tableNameOf = (t: unknown): string => {
    try {
      return getTableName(t as Table);
    } catch {
      return "unknown";
    }
  };
  return {
    execute: async (sqlExpr: unknown) => {
      hooks.executeCalls.push({ chunks: sqlToText(sqlExpr) });
      return { rows: [] };
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_w: unknown) => ({
          limit: async () => {
            const name = tableNameOf(table);
            if (name === "turns") {
              if (hooks.turnExists === false) return [];
              return [{ chronicledAt: hooks.turnChronicledAt ?? null }];
            }
            if (name === "campaigns") {
              if (hooks.campaignExists === false) return [];
              return [
                {
                  id: CAMPAIGN,
                  userId: "u-1",
                  settings: {},
                  deletedAt: null,
                  name: "test",
                },
              ];
            }
            return [];
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (patch: unknown) => {
        hooks.updateCalls.push({ patch });
        return {
          where: async () => ({ rowCount: 1 }),
        };
      },
    }),
  } as unknown as Db;
}

/** Stub query that yields a successful result so runChronicler returns clean. */
const stubQuery = (() =>
  (async function* () {
    yield {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      session_id: "test",
    };
  })()) as never;

function baseInput(overrides: Partial<Parameters<typeof chronicleTurn>[0]> = {}) {
  return {
    turnId: TURN_ID,
    campaignId: CAMPAIGN,
    userId: "u-1",
    turnNumber: 7,
    playerMessage: "look around",
    narrative: "The bar is dimly lit. Jet nurses a drink.",
    intent,
    outcome,
    arcTrigger: null as null,
    ...overrides,
  };
}

describe("chronicleTurn — wrapper semantics (Commit 7.4)", () => {
  it("happy path: acquires lock, runs Chronicler, marks chronicled_at, releases lock", async () => {
    const hooks: DbHooks = { executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    const result = await chronicleTurn(baseInput(), { db, queryFn: stubQuery });
    expect(result).toBe("ok");

    // Lock acquire + release both fired (execute called at least twice with pg_advisory_lock / unlock).
    const lockSqls = hooks.executeCalls.map((c) => c.chunks).join(" | ");
    expect(lockSqls).toMatch(/pg_advisory_lock/);
    expect(lockSqls).toMatch(/pg_advisory_unlock/);

    // chronicled_at was set via update.
    expect(hooks.updateCalls).toHaveLength(1);
    const patch = hooks.updateCalls[0]?.patch as Record<string, unknown>;
    expect(patch.chronicledAt).toBeInstanceOf(Date);
  });

  it("idempotency: already-chronicled turn returns 'already_chronicled' without running Chronicler", async () => {
    const hooks: DbHooks = {
      turnChronicledAt: new Date("2026-04-20T12:00:00Z"),
      executeCalls: [],
      updateCalls: [],
    };
    const db = fakeDb(hooks);
    let queryCalled = false;
    const queryFn = (() => {
      queryCalled = true;
      return (async function* () {
        yield { type: "result", subtype: "success", stop_reason: "end_turn" };
      })();
    }) as never;
    const result = await chronicleTurn(baseInput(), { db, queryFn });
    expect(result).toBe("already_chronicled");
    expect(queryCalled).toBe(false);
    expect(hooks.updateCalls).toHaveLength(0); // didn't re-stamp chronicled_at
  });

  it("returns 'failed' when the turn row is missing", async () => {
    const hooks: DbHooks = { turnExists: false, executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    const result = await chronicleTurn(baseInput(), { db, queryFn: stubQuery });
    expect(result).toBe("failed");
    expect(hooks.updateCalls).toHaveLength(0);
    // Lock release still happened (lock was acquired before the turn-row check).
    const lockSqls = hooks.executeCalls.map((c) => c.chunks).join(" | ");
    expect(lockSqls).toMatch(/pg_advisory_unlock/);
  });

  it("returns 'failed' when the campaign is missing (deleted or transferred)", async () => {
    const hooks: DbHooks = { campaignExists: false, executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    const result = await chronicleTurn(baseInput(), { db, queryFn: stubQuery });
    expect(result).toBe("failed");
    expect(hooks.updateCalls).toHaveLength(0);
  });

  it("swallows Chronicler errors and returns 'failed' without rethrowing", async () => {
    const hooks: DbHooks = { executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    // Stub that throws the "result error" path Chronicler surfaces.
    const throwingQuery = (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          stop_reason: "max_turns",
        };
      })()) as never;
    const result = await chronicleTurn(baseInput(), { db, queryFn: throwingQuery });
    expect(result).toBe("failed"); // NOT thrown
    expect(hooks.updateCalls).toHaveLength(0); // chronicled_at NOT set on failure
    // Lock released on error path too.
    const lockSqls = hooks.executeCalls.map((c) => c.chunks).join(" | ");
    expect(lockSqls).toMatch(/pg_advisory_unlock/);
  });

  it("skips chronicled_at stamping when runChronicler fails (idempotency-safe retry)", async () => {
    const hooks: DbHooks = { executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    const throwingQuery = (() =>
      (async function* () {
        yield { type: "result", subtype: "error_max_turns", stop_reason: "max_turns" };
      })()) as never;
    await chronicleTurn(baseInput(), { db, queryFn: throwingQuery });
    // Since chronicled_at wasn't set, a later retry would re-run Chronicler.
    expect(
      hooks.updateCalls.filter((u) => (u.patch as { chronicledAt?: unknown }).chronicledAt),
    ).toHaveLength(0);
  });

  it("lock keys are namespace-shifted from turn-pipeline keys (different int4 pair)", async () => {
    // Exercise two chronicleTurn calls with different namespace offsets:
    // the lock keys must differ from the turn-pipeline namespace (offset=0)
    // and the default Chronicler namespace.
    const hooks: DbHooks = { executeCalls: [], updateCalls: [] };
    const db = fakeDb(hooks);
    await chronicleTurn(baseInput(), { db, queryFn: stubQuery });
    const defaultLockLines = hooks.executeCalls
      .filter((c) => c.chunks.includes("pg_advisory_lock"))
      .map((c) => c.chunks);

    hooks.executeCalls.length = 0;
    hooks.updateCalls.length = 0;
    await chronicleTurn(baseInput(), { db, queryFn: stubQuery, _lockNamespaceOffset: 0 });
    const offsetLockLines = hooks.executeCalls
      .filter((c) => c.chunks.includes("pg_advisory_lock"))
      .map((c) => c.chunks);
    // We can't easily assert the int values without deeper SQL parsing,
    // but we CAN assert the two runs produced different lock sql strings
    // (since the integers within the sql template differ).
    expect(defaultLockLines.length).toBeGreaterThan(0);
    expect(offsetLockLines.length).toBeGreaterThan(0);
    expect(defaultLockLines[0]).not.toBe(offsetLockLines[0]);
  });
});

describe("computeArcTrigger — M1 heuristic", () => {
  it("fires 'hybrid' when epicness >= 0.6 AND turnNumber % 3 === 0", () => {
    expect(computeArcTrigger(0.6, 3)).toBe("hybrid");
    expect(computeArcTrigger(0.8, 9)).toBe("hybrid");
    expect(computeArcTrigger(1.0, 30)).toBe("hybrid");
  });

  it("returns null when epicness < 0.6", () => {
    expect(computeArcTrigger(0.59, 3)).toBe(null);
    expect(computeArcTrigger(0.3, 9)).toBe(null);
    expect(computeArcTrigger(0.0, 30)).toBe(null);
  });

  it("returns null when turnNumber is not a multiple of 3", () => {
    expect(computeArcTrigger(0.8, 1)).toBe(null);
    expect(computeArcTrigger(0.8, 2)).toBe(null);
    expect(computeArcTrigger(0.8, 4)).toBe(null);
    expect(computeArcTrigger(0.8, 5)).toBe(null);
    expect(computeArcTrigger(0.8, 7)).toBe(null);
  });

  it("session_boundary is not produced at M1 (scaffolded for post-M1)", () => {
    // The type allows "session_boundary" but the M1 implementation
    // never returns it — session tracking lands later. Pin this so a
    // future change surfaces in review.
    const samples = [
      [1.0, 0],
      [1.0, 100],
      [0.5, 50],
      [0.0, 0],
    ] as const;
    for (const [ep, tn] of samples) {
      expect(computeArcTrigger(ep, tn)).not.toBe("session_boundary");
    }
  });
});
