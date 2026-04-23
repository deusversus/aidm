import { createMockAnthropic, createMockGoogle } from "@/lib/llm/mock/testing";
import type { CampaignProviderConfig } from "@/lib/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Runner tests. Every structured-output consultant routes through
 * runStructuredAgent, so retry / fallback / span coverage here is the
 * test surface for the whole cascade. Per-agent tests verify their
 * schemas and user-content rendering, not the runner's infra.
 *
 * M1.5 inversion: provider dispatch now comes from `deps.modelContext`
 * (or `anthropicFallbackConfig()` when absent), NOT from `config.tier`.
 * These tests verify both branches — default (Anthropic fallback) and
 * explicit (modelContext with provider=google).
 *
 * Mock stubs come from `@/lib/llm/mock/testing` (Phase E of v3-audit
 * closure's mockllm plan) — replaces the scattered inline fakes.
 */

const OutSchema = z.object({ value: z.string() });
type Out = z.infer<typeof OutSchema>;

function baseConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentName: "test-agent",
    tier: "fast" as const,
    systemPrompt: "system",
    userContent: "user",
    outputSchema: OutSchema,
    fallback: { value: "fallback" } as Out,
    ...overrides,
  };
}

const googleContext: CampaignProviderConfig = {
  provider: "google",
  tier_models: {
    probe: "claude-haiku-4-5-20251001",
    fast: "gemini-3.1-flash-lite-preview",
    thinking: "gemini-3.1-pro-preview",
    creative: "gemini-3.1-pro-preview",
  },
};

describe("runStructuredAgent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("provider dispatch", () => {
    it("routes to Anthropic by default (no modelContext → anthropicFallbackConfig)", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { anthropic });
      expect(result.value).toBe("ok");
    });

    it("routes to Google when modelContext provider='google'", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = createMockGoogle([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, {
        modelContext: googleContext,
        google,
      });
      expect(result.value).toBe("ok");
    });

    it("uses the tier-appropriate model from modelContext.tier_models", async () => {
      const { runStructuredAgent } = await import("../_runner");
      let seenModel: string | undefined;
      const anthropic = createMockAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echo: (p) => {
            seenModel = (p as { model: string }).model;
          },
        },
      ]);
      await runStructuredAgent<Out>(baseConfig({ tier: "thinking" }) as never, { anthropic });
      // thinking default changed 2026-04-23 from Opus 4.7 → Sonnet 4.6.
      expect(seenModel).toBe("claude-sonnet-4-6");
    });

    it("honors an explicit Anthropic modelContext with a non-default creative model", async () => {
      const { runStructuredAgent } = await import("../_runner");
      let seenModel: string | undefined;
      const anthropic = createMockAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echo: (p) => {
            seenModel = (p as { model: string }).model;
          },
        },
      ]);
      const customContext: CampaignProviderConfig = {
        provider: "anthropic",
        tier_models: {
          probe: "claude-haiku-4-5-20251001",
          fast: "claude-haiku-4-5-20251001",
          thinking: "claude-opus-4-5-20251101", // snapshot pin
          creative: "claude-sonnet-4-6", // cost-down creative
        },
      };
      await runStructuredAgent<Out>(baseConfig({ tier: "creative" }) as never, {
        modelContext: customContext,
        anthropic,
      });
      expect(seenModel).toBe("claude-sonnet-4-6");
    });

    it("throws when provider is openai (not yet available)", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const openaiContext: CampaignProviderConfig = {
        provider: "openai",
        tier_models: {
          probe: "x",
          fast: "x",
          thinking: "x",
          creative: "x",
        },
      };
      await expect(
        runStructuredAgent<Out>(baseConfig() as never, { modelContext: openaiContext }),
      ).rejects.toThrow(/M5\.5/);
    });
  });

  describe("retry + fallback", () => {
    it("retries once on malformed JSON and recovers", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = createMockAnthropic([
        { text: "not json" },
        { text: JSON.stringify({ value: "recovered" }) },
      ]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { anthropic });
      expect(result.value).toBe("recovered");
    });

    it("falls back when retries exhaust", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = createMockAnthropic([{ text: "garbage" }, { text: "still garbage" }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { anthropic });
      expect(result.value).toBe("fallback");
    });

    it("falls back on network errors", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = createMockAnthropic([
        { error: new Error("ECONNRESET") },
        { error: new Error("ECONNRESET") },
      ]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { anthropic });
      expect(result.value).toBe("fallback");
    });

    it("strips markdown fences", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const body = JSON.stringify({ value: "fenced" });
      const anthropic = createMockAnthropic([{ text: `\`\`\`json\n${body}\n\`\`\`` }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { anthropic });
      expect(result.value).toBe("fenced");
    });

    it("logs warn on each attempt failure and error on fallback", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const logs: Array<[string, string]> = [];
      const anthropic = createMockAnthropic([{ text: "garbage" }, { text: "still garbage" }]);
      await runStructuredAgent<Out>(baseConfig() as never, {
        anthropic,
        logger: (level, msg) => logs.push([level, msg]),
      });
      expect(logs.filter(([l]) => l === "warn")).toHaveLength(2);
      expect(logs.some(([l, m]) => l === "error" && m.includes("fell back"))).toBe(true);
    });
  });

  describe("thinking budget", () => {
    it("passes budget_tokens to Anthropic when thinkingBudget > 0", async () => {
      const { runStructuredAgent } = await import("../_runner");
      let capturedParams: Record<string, unknown> | undefined;
      const anthropic = createMockAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echo: (p) => {
            capturedParams = p as Record<string, unknown>;
          },
        },
      ]);
      await runStructuredAgent<Out>(
        baseConfig({ tier: "thinking", thinkingBudget: 2048 }) as never,
        { anthropic },
      );
      const thinking = capturedParams?.thinking as { type: string; budget_tokens: number };
      expect(thinking).toBeDefined();
      expect(thinking.type).toBe("enabled");
      expect(thinking.budget_tokens).toBe(2048);
    });

    it("increases max_tokens above thinking budget to avoid the API constraint", async () => {
      const { runStructuredAgent } = await import("../_runner");
      let capturedParams: Record<string, unknown> | undefined;
      const anthropic = createMockAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echo: (p) => {
            capturedParams = p as Record<string, unknown>;
          },
        },
      ]);
      await runStructuredAgent<Out>(
        baseConfig({
          tier: "thinking",
          thinkingBudget: 4096,
          maxTokens: 512, // intentionally smaller than budget
        }) as never,
        { anthropic },
      );
      const max = capturedParams?.max_tokens as number;
      expect(max).toBeGreaterThan(4096);
    });

    it("omits thinking param on Google path even if thinkingBudget is set", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = createMockGoogle([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(
        baseConfig({ tier: "fast", thinkingBudget: 2048 }) as never,
        { modelContext: googleContext, google },
      );
      // Google path silently ignores thinkingBudget (different mechanism).
      expect(result.value).toBe("ok");
    });
  });

  describe("prompt fingerprint recording (Commit 7.0)", () => {
    it("records fingerprint when promptId + recordPrompt are both set", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const recorded: Array<[string, string]> = [];
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      // Use an actual registry id so getPrompt returns a real fingerprint.
      await runStructuredAgent<Out>(baseConfig({ promptId: "agents/outcome-judge" }) as never, {
        anthropic,
        recordPrompt: (name, fp) => recorded.push([name, fp]),
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.[0]).toBe("test-agent");
      expect(recorded[0]?.[1]).toMatch(/^[0-9a-f]{64}$/);
    });

    it("skips recording when promptId is absent (literal systemPrompt path)", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const recorded: Array<[string, string]> = [];
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      await runStructuredAgent<Out>(baseConfig() as never, {
        anthropic,
        recordPrompt: (name, fp) => recorded.push([name, fp]),
      });
      expect(recorded).toHaveLength(0);
    });

    it("skips recording when recordPrompt is absent (null-safe)", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      // No recordPrompt in deps — should not throw.
      const result = await runStructuredAgent<Out>(
        baseConfig({ promptId: "agents/outcome-judge" }) as never,
        { anthropic },
      );
      expect(result.value).toBe("ok");
    });

    it("swallows getPrompt throws when promptId is bogus — agent still runs", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const recorded: Array<[string, string]> = [];
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(
        baseConfig({ promptId: "does/not/exist" }) as never,
        {
          anthropic,
          recordPrompt: (name, fp) => recorded.push([name, fp]),
        },
      );
      // Call succeeded; nothing recorded (lookup threw, swallowed).
      expect(result.value).toBe("ok");
      expect(recorded).toHaveLength(0);
    });

    it("records once, not per retry attempt", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const recorded: Array<[string, string]> = [];
      // First attempt fails parse; second succeeds. Recording should happen
      // exactly once — reflecting the prompt the agent intended to run,
      // not a per-attempt duplicate.
      const anthropic = createMockAnthropic([
        { text: "not json" },
        { text: JSON.stringify({ value: "recovered" }) },
      ]);
      await runStructuredAgent<Out>(baseConfig({ promptId: "agents/outcome-judge" }) as never, {
        anthropic,
        recordPrompt: (name, fp) => recorded.push([name, fp]),
      });
      expect(recorded).toHaveLength(1);
    });
  });

  describe("span wrapping", () => {
    it("creates a span named agent:<name> and ends with output on success", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const spans: Array<{ name: string; endedWith: unknown }> = [];
      const trace = {
        span(opts: { name: string; metadata?: Record<string, unknown> }) {
          const entry = { name: opts.name, endedWith: undefined as unknown };
          spans.push(entry);
          return {
            end(data?: { output?: unknown; metadata?: Record<string, unknown> }) {
              entry.endedWith = data;
            },
          };
        },
      };
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "traced" }) }]);
      await runStructuredAgent<Out>(baseConfig() as never, { anthropic, trace });
      expect(spans[0]?.name).toBe("agent:test-agent");
      expect(spans[0]?.endedWith).toMatchObject({
        output: { value: "traced" },
        metadata: { attempt: 1 },
      });
    });

    it("ends span with fallback + error metadata when falling back", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const spans: Array<{ endedWith: unknown }> = [];
      const trace = {
        span() {
          const entry = { endedWith: undefined as unknown };
          spans.push(entry);
          return {
            end(data?: unknown) {
              entry.endedWith = data;
            },
          };
        },
      };
      const anthropic = createMockAnthropic([{ text: "x" }, { text: "y" }]);
      await runStructuredAgent<Out>(baseConfig() as never, { anthropic, trace });
      expect(spans[0]?.endedWith).toMatchObject({
        output: { value: "fallback" },
        metadata: { fallback: true },
      });
    });

    it("span metadata includes provider + resolved model", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const spans: Array<{ metadata?: Record<string, unknown> }> = [];
      const trace = {
        span(opts: { name: string; metadata?: Record<string, unknown> }) {
          const entry = { metadata: opts.metadata };
          spans.push(entry);
          return { end() {} };
        },
      };
      const anthropic = createMockAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      await runStructuredAgent<Out>(baseConfig({ tier: "thinking" }) as never, {
        anthropic,
        trace,
      });
      expect(spans[0]?.metadata).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6", // thinking default changed 2026-04-23 from Opus 4.7
        tier: "thinking",
      });
    });
  });
});
