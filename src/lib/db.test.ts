import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getDb singleton", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Belt-and-suspenders: `tests/setup.ts` also calls resetModules(), but
    // this test's correctness depends on the db module's `_db`/`_pool`
    // singletons being fresh per case. Explicit reset prevents a future
    // refactor of setup.ts from silently breaking these assertions.
    vi.resetModules();
    process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns the same Drizzle instance on repeated calls", async () => {
    const { getDb } = await import("./db");
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });

  it("throws a configuration error when DATABASE_URL is missing on first call", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    const { getDb } = await import("./db");
    expect(() => getDb()).toThrow(/DATABASE_URL/);
  });
});
