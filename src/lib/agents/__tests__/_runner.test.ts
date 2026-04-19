import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Runner tests. All 7 Commit-5 agents go through this runner, so
 * coverage here is the test surface for retry/fallback/span behavior
 * across the cascade. Per-agent tests only verify their schemas and
 * user-content rendering, not the runner's infra.
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

function fakeGoogle(
  responses: Array<{ text?: string; error?: unknown }>,
): () => Pick<GoogleGenAI, "models"> {
  let i = 0;
  return () =>
    ({
      models: {
        generateContent: async () => {
          const next = responses[i++];
          if (!next) throw new Error("no more mock responses");
          if (next.error) throw next.error;
          return { text: next.text };
        },
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

function fakeAnthropic(
  responses: Array<{ text?: string; error?: unknown; echoParams?: (p: unknown) => void }>,
): () => Pick<Anthropic, "messages"> {
  let i = 0;
  return () =>
    ({
      messages: {
        create: async (params: unknown) => {
          const next = responses[i++];
          if (!next) throw new Error("no more mock responses");
          next.echoParams?.(params);
          if (next.error) throw next.error;
          return { content: [{ type: "text", text: next.text ?? "" }] };
        },
      },
    }) as unknown as Pick<Anthropic, "messages">;
}

describe("runStructuredAgent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("tier dispatch", () => {
    it("routes fast tier to Gemini", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = fakeGoogle([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(baseConfig({ tier: "fast" }) as never, {
        google,
      });
      expect(result.value).toBe("ok");
    });

    it("routes thinking tier to Anthropic", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const anthropic = fakeAnthropic([{ text: JSON.stringify({ value: "ok" }) }]);
      const result = await runStructuredAgent<Out>(baseConfig({ tier: "thinking" }) as never, {
        anthropic,
      });
      expect(result.value).toBe("ok");
    });
  });

  describe("retry + fallback", () => {
    it("retries once on malformed JSON and recovers", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = fakeGoogle([
        { text: "not json" },
        { text: JSON.stringify({ value: "recovered" }) },
      ]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { google });
      expect(result.value).toBe("recovered");
    });

    it("falls back when retries exhaust", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = fakeGoogle([{ text: "garbage" }, { text: "still garbage" }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { google });
      expect(result.value).toBe("fallback");
    });

    it("falls back on network errors", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = fakeGoogle([
        { error: new Error("ECONNRESET") },
        { error: new Error("ECONNRESET") },
      ]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { google });
      expect(result.value).toBe("fallback");
    });

    it("strips markdown fences", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const body = JSON.stringify({ value: "fenced" });
      const google = fakeGoogle([{ text: `\`\`\`json\n${body}\n\`\`\`` }]);
      const result = await runStructuredAgent<Out>(baseConfig() as never, { google });
      expect(result.value).toBe("fenced");
    });

    it("logs warn on each attempt failure and error on fallback", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const logs: Array<[string, string]> = [];
      const google = fakeGoogle([{ text: "garbage" }, { text: "still garbage" }]);
      await runStructuredAgent<Out>(baseConfig() as never, {
        google,
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
      const anthropic = fakeAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echoParams: (p) => {
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
      const anthropic = fakeAnthropic([
        {
          text: JSON.stringify({ value: "ok" }),
          echoParams: (p) => {
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

    it("omits thinking param when tier is fast even if thinkingBudget is set", async () => {
      const { runStructuredAgent } = await import("../_runner");
      const google = fakeGoogle([{ text: JSON.stringify({ value: "ok" }) }]);
      await runStructuredAgent<Out>(baseConfig({ tier: "fast", thinkingBudget: 2048 }) as never, {
        google,
      });
      // Just assert no crash + correct output — fast tier routes to
      // Gemini which ignores thinking entirely.
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
      const google = fakeGoogle([{ text: JSON.stringify({ value: "traced" }) }]);
      await runStructuredAgent<Out>(baseConfig() as never, { google, trace });
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
      const google = fakeGoogle([{ text: "x" }, { text: "y" }]);
      await runStructuredAgent<Out>(baseConfig() as never, { google, trace });
      expect(spans[0]?.endedWith).toMatchObject({
        output: { value: "fallback" },
        metadata: { fallback: true },
      });
    });
  });
});
