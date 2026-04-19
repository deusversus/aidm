import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getLangfuse", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when keys are missing (caller no-ops silently)", async () => {
    Reflect.deleteProperty(process.env, "LANGFUSE_PUBLIC_KEY");
    Reflect.deleteProperty(process.env, "LANGFUSE_SECRET_KEY");
    const { getLangfuse } = await import("./langfuse");
    expect(getLangfuse()).toBeNull();
  });

  it("returns null when only public key is set", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-xxx";
    Reflect.deleteProperty(process.env, "LANGFUSE_SECRET_KEY");
    const { getLangfuse } = await import("./langfuse");
    expect(getLangfuse()).toBeNull();
  });
});
