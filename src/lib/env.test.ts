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
    const { env } = await import("./env");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("ownKeys works for spread/destructure", async () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    const { env } = await import("./env");
    const keys = Object.keys(env);
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("NODE_ENV");
  });
});

describe("tiers config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("declares fast, thinking, creative tiers", async () => {
    const { tiers } = await import("./env");
    expect(tiers.fast.provider).toBe("google");
    expect(tiers.fast.model).toBe("gemini-3.1-flash");
    expect(tiers.thinking.provider).toBe("anthropic");
    expect(tiers.thinking.model).toBe("claude-opus-4-7");
    expect(tiers.creative.model).toBe("claude-opus-4-7");
  });
});
