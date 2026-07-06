import { createMockAnthropic as fakeAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Intent classifier tests. Routes through the shared runStructuredAgent
 * (as of M1.5 Commit C). Default modelContext is Anthropic fallback, so
 * these tests inject an Anthropic fake. Provider-dispatch behavior is
 * covered in _runner.test.ts.
 *
 * Mock stub via unified helper (Phase E of mockllm plan).
 */

describe("classifyIntent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns a validated IntentOutput on a well-formed response", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          intent: "COMBAT",
          action: "strike the goblin",
          target: "goblin",
          epicness: 0.55,
          special_conditions: [],
          confidence: 0.92,
        }),
      },
    ]);
    const result = await classifyIntent(
      { playerMessage: "I attack the goblin", recentTurnsSummary: "", campaignPhase: "playing" },
      { anthropic },
    );
    expect(result.intent).toBe("COMBAT");
    expect(result.target).toBe("goblin");
    expect(result.confidence).toBeCloseTo(0.92);
  });

  it("strips markdown code fences if the model returns them", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const body = JSON.stringify({
      intent: "SOCIAL",
      epicness: 0.3,
      special_conditions: [],
      confidence: 0.8,
    });
    const anthropic = fakeAnthropic([{ text: `\`\`\`json\n${body}\n\`\`\`` }]);
    const result = await classifyIntent({ playerMessage: "greet the vendor" }, { anthropic });
    expect(result.intent).toBe("SOCIAL");
    expect(result.confidence).toBeCloseTo(0.8);
  });

  it("retries once on malformed JSON, returns valid output on retry", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const anthropic = fakeAnthropic([
      { text: "not valid json at all" },
      {
        text: JSON.stringify({
          intent: "EXPLORATION",
          epicness: 0.25,
          special_conditions: [],
          confidence: 0.7,
        }),
      },
    ]);
    const result = await classifyIntent({ playerMessage: "look around" }, { anthropic });
    expect(result.intent).toBe("EXPLORATION");
  });

  it("falls back to DEFAULT after exhausting retries", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const logged: Array<[string, string]> = [];
    const anthropic = fakeAnthropic([{ text: "garbage" }, { text: "still garbage" }]);
    const result = await classifyIntent(
      { playerMessage: "mystery action" },
      {
        anthropic,
        logger: (level, msg) => logged.push([level, msg]),
      },
    );
    expect(result.intent).toBe("DEFAULT");
    expect(result.confidence).toBe(0);
    expect(logged.some(([level, msg]) => level === "error" && msg.includes("fell back"))).toBe(
      true,
    );
  });

  it("falls back to DEFAULT on network errors", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const anthropic = fakeAnthropic([
      { error: new Error("ECONNRESET") },
      { error: new Error("ECONNRESET") },
    ]);
    const result = await classifyIntent({ playerMessage: "x" }, { anthropic });
    expect(result.intent).toBe("DEFAULT");
  });

  it("logs a warning on low confidence but returns the classification as-is", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const logged: Array<[string, string]> = [];
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          intent: "ABILITY",
          epicness: 0.5,
          special_conditions: [],
          confidence: 0.4, // below threshold
        }),
      },
    ]);
    const result = await classifyIntent(
      { playerMessage: "do the thing" },
      { anthropic, logger: (level, msg) => logged.push([level, msg]) },
    );
    expect(result.intent).toBe("ABILITY");
    expect(result.confidence).toBe(0.4);
    expect(logged.some(([level, msg]) => level === "warn" && msg.includes("low confidence"))).toBe(
      true,
    );
  });

  it("rejects malformed input before hitting the provider", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    let called = false;
    const anthropic = fakeAnthropic([
      {
        text: "{}",
        echo: () => {
          called = true;
        },
      },
    ]);
    // Empty playerMessage should fail the input Zod schema.
    await expect(classifyIntent({ playerMessage: "" }, { anthropic })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("wraps execution in a span when a trace is provided", async () => {
    const { classifyIntent } = await import("../intent-classifier");
    const spans: Array<{ name: string; endedWith: unknown }> = [];
    const trace = {
      span(opts: { name: string; input?: unknown; metadata?: Record<string, unknown> }) {
        const entry = { name: opts.name, endedWith: undefined as unknown };
        spans.push(entry);
        return {
          end(data?: { output?: unknown; metadata?: Record<string, unknown> }) {
            entry.endedWith = data;
          },
        };
      },
    };
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          intent: "DEFAULT",
          epicness: 0.1,
          special_conditions: [],
          confidence: 0.9,
        }),
      },
    ]);
    await classifyIntent({ playerMessage: "hi" }, { anthropic, trace });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("agent:intent-classifier");
    expect(spans[0]?.endedWith).toMatchObject({
      output: expect.objectContaining({ intent: "DEFAULT" }),
    });
  });
});
