import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("getDb singleton", () => {
  const originalEnv = process.env;

  beforeEach(() => {
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

  it("throws ZodError when DATABASE_URL is missing on first call", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    const { getDb } = await import("./db");
    expect(() => getDb()).toThrow();
  });
});
