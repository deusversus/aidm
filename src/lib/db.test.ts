import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getDb", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("importing the module does not touch env or construct a pool", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    await expect(import("./db")).resolves.toBeDefined();
  });

  it("throws a configuration-shaped error when DATABASE_URL is missing", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    const { getDb } = await import("./db");
    expect(() => getDb()).toThrow(/DATABASE_URL not configured/);
  });

  it("rejects a non-URL DATABASE_URL via the env Proxy", async () => {
    process.env.DATABASE_URL = "not-a-url";
    const { getDb } = await import("./db");
    expect(() => getDb()).toThrow();
  });
});
