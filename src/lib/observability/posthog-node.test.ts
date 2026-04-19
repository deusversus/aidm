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
});
