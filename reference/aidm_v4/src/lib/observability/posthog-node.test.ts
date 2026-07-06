import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getPostHog (server)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when NEXT_PUBLIC_POSTHOG_KEY is unset", async () => {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
    const { getPostHog } = await import("./posthog-node");
    expect(getPostHog()).toBeNull();
  });

  it("returns the same client instance on repeated calls when key is set", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_singleton_key";
    const { getPostHog } = await import("./posthog-node");
    const a = getPostHog();
    const b = getPostHog();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // posthog-node starts background timers — shut it down so Vitest exits cleanly.
    await a?.shutdown();
  });
});
