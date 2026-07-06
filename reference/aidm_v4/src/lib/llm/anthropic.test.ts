import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("pingAnthropic", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false when ANTHROPIC_API_KEY is unset (no network call)", async () => {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const { pingAnthropic } = await import("./anthropic");
    const ok = await pingAnthropic(500);
    expect(ok).toBe(false);
  });
});

describe("getAnthropic", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const { getAnthropic } = await import("./anthropic");
    expect(() => getAnthropic()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("returns the same client instance on repeated calls", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-singleton-key";
    const { getAnthropic } = await import("./anthropic");
    const a = getAnthropic();
    const b = getAnthropic();
    expect(a).toBe(b);
  });
});
