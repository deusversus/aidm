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

describe("anthropicDefaults (fallback-only; authoritative config is per-campaign tier_models)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("declares probe / fast / thinking / creative keys with Anthropic model strings", async () => {
    const { anthropicDefaults } = await import("./env");
    expect(anthropicDefaults.probe).toBe("claude-haiku-4-5-20251001");
    expect(anthropicDefaults.fast).toBe("claude-haiku-4-5-20251001");
    expect(anthropicDefaults.thinking).toBe("claude-opus-4-7");
    expect(anthropicDefaults.creative).toBe("claude-opus-4-7");
  });

  it("matches ANTHROPIC_DEFAULTS from the providers registry (single source of truth)", async () => {
    const { anthropicDefaults } = await import("./env");
    const { ANTHROPIC_DEFAULTS } = await import("./providers");
    expect(anthropicDefaults).toEqual(ANTHROPIC_DEFAULTS);
  });
});
