import { describe, expect, it, vi } from "vitest";

/**
 * Mocked counters tests — verify the Drizzle call shapes and fallback
 * semantics without a running Postgres. Real-DB concurrency / atomicity
 * tests would live alongside this file as `counters.real-db.test.ts`,
 * gated behind `TEST_DATABASE_URL` so they only run when a dev DB is
 * available (not wired at M1).
 */

describe("counters — increment return shapes", () => {
  it("incrementRateCounter returns the count from the returning row", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [{ count: 5 }],
            }),
          }),
        }),
      }),
    }));
    const { incrementRateCounter } = await import("../counters");
    const result = await incrementRateCounter("user-1", new Date(Date.UTC(2026, 3, 22, 15, 42)));
    expect(result).toBe(5);
  });

  it("incrementRateCounter falls back to 1 when returning is empty", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [],
            }),
          }),
        }),
      }),
    }));
    const { incrementRateCounter } = await import("../counters");
    const result = await incrementRateCounter("user-1");
    expect(result).toBe(1);
  });

  it("incrementCostLedger returns numeric from the returning row", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: async () => [{ totalCostUsd: "1.234567" }],
            }),
          }),
        }),
      }),
    }));
    const { incrementCostLedger } = await import("../counters");
    const result = await incrementCostLedger("user-1", 0.5);
    expect(result).toBeCloseTo(1.234567, 5);
  });

  it("getCurrentRateCount returns 0 when no row exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    }));
    const { getCurrentRateCount } = await import("../counters");
    const count = await getCurrentRateCount("user-1");
    expect(count).toBe(0);
  });

  it("getCurrentDayCost returns 0 when no ledger row exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    }));
    const { getCurrentDayCost } = await import("../counters");
    const cost = await getCurrentDayCost("user-1");
    expect(cost).toBe(0);
  });

  it("getUserDailyCap returns null when column is null", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ dailyCostCapUsd: null }],
            }),
          }),
        }),
      }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBeNull();
  });

  it("getUserDailyCap returns 0 (not null) when user set cap = 0", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ dailyCostCapUsd: "0.00" }],
            }),
          }),
        }),
      }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBe(0);
  });

  it("getUserDailyCap returns null when user row doesn't exist", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    }));
    const { getUserDailyCap } = await import("../counters");
    const cap = await getUserDailyCap("user-1");
    expect(cap).toBeNull();
  });

  it("setUserDailyCap passes null through for clear, not '0.00'", async () => {
    const updateCalls: unknown[] = [];
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDb: () => ({
        update: () => ({
          set: (s: unknown) => {
            updateCalls.push(s);
            return {
              where: async () => [],
            };
          },
        }),
      }),
    }));
    const { setUserDailyCap } = await import("../counters");
    await setUserDailyCap("user-1", null);
    await setUserDailyCap("user-1", 0);
    await setUserDailyCap("user-1", 10);
    expect(updateCalls[0]).toEqual({ dailyCostCapUsd: null });
    expect(updateCalls[1]).toEqual({ dailyCostCapUsd: "0.00" });
    expect(updateCalls[2]).toEqual({ dailyCostCapUsd: "10.00" });
  });
});
