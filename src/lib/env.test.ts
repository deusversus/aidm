import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("env Proxy", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reads a valid DATABASE_URL through property access", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    const { env } = await import("./env");
    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/db");
  });

  it("throws ZodError when DATABASE_URL is missing and is accessed", async () => {
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    const { env } = await import("./env");
    expect(() => env.DATABASE_URL).toThrow();
  });

  it("applies default for NODE_ENV when unset", async () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    Reflect.deleteProperty(process.env, "NODE_ENV");
    const { env } = await import("./env");
    expect(env.NODE_ENV).toBe("development");
  });

  it("applies default for LANGFUSE_HOST", async () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    Reflect.deleteProperty(process.env, "LANGFUSE_HOST");
    const { env } = await import("./env");
    expect(env.LANGFUSE_HOST).toBe("https://us.cloud.langfuse.com");
  });

  it("leaves optional keys undefined when unset", async () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { env } = await import("./env");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.VOYAGE_API_KEY).toBeUndefined();
  });

  it("re-parses when a cached-undefined key later appears in process.env", async () => {
    // The parse-once cache must not report a key missing forever after one
    // parse against a partial process.env — it heals on the next read.
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { env } = await import("./env");
    expect(env.VOYAGE_API_KEY).toBeUndefined();
    process.env.VOYAGE_API_KEY = "pa-late-arrival";
    expect(env.VOYAGE_API_KEY).toBe("pa-late-arrival");
  });

  it("ownKeys works for spread/destructure", async () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    const { env } = await import("./env");
    const keys = Object.keys(env);
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("NODE_ENV");
  });
});
