import {
  CLASSIFY,
  LOOPED_LARGE,
  PROSE_COMPOSER,
  STRUCTURED_RICH,
  STRUCTURED_SMALL,
} from "@/lib/llm/budgets";
import { callJudgment, computeEffectiveMaxTokens } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The M2R2 §6 budget mechanism. The pure-math half (computeEffectiveMaxTokens)
 * needs no model; the truncation/retry half mocks the raw SDK client following
 * calls.toolloop.test.ts — no live model, no DB, no Langfuse.
 */

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({
    messages: {
      create: createMock,
      // Structured calls ride streaming transport (SDK 10-minute guard);
      // the same fixture answers finalMessage().
      stream: (params: unknown) => ({ finalMessage: () => createMock(params) }),
    },
  }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));

const SCHEMA = z.object({ ok: z.boolean() });

function msg(text: string, stopReason: string) {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

beforeEach(() => createMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("budget classes (M2R2 §6 rationale pins)", () => {
  it("named output-budget classes hold their values", () => {
    expect(CLASSIFY).toBe(1_000);
    expect(STRUCTURED_SMALL).toBe(2_000);
    expect(STRUCTURED_RICH).toBe(8_000);
    expect(LOOPED_LARGE).toBe(16_000);
    expect(PROSE_COMPOSER).toBe(8_000);
  });
});

describe("computeEffectiveMaxTokens", () => {
  it("adds no pad for a non-thinking model (Haiku — neither adaptive nor effort)", () => {
    expect(computeEffectiveMaxTokens(1_000, "claude-haiku-4-5")).toBe(1_000);
    // effort is irrelevant to a model that does no server-side reasoning.
    expect(computeEffectiveMaxTokens(1_000, "claude-haiku-4-5", "high")).toBe(1_000);
  });

  it("scales the pad by effort on an adaptive-thinking model", () => {
    const m = "claude-opus-4-8";
    expect(computeEffectiveMaxTokens(1_000, m, "low")).toBe(1_000 + 8_000);
    expect(computeEffectiveMaxTokens(1_000, m, "medium")).toBe(1_000 + 12_000);
    // 24k (M2R2 audit): genga, the default narration tier, runs effort high —
    // the pad must cover the old flat +24k's measured deep-scene thinking.
    expect(computeEffectiveMaxTokens(1_000, m, "high")).toBe(1_000 + 24_000);
    expect(computeEffectiveMaxTokens(1_000, m, "xhigh")).toBe(1_000 + 32_000);
    expect(computeEffectiveMaxTokens(1_000, m, "max")).toBe(1_000 + 32_000);
  });

  it("pads an effort-less adaptive call by 8k (it still reasons)", () => {
    expect(computeEffectiveMaxTokens(2_000, "claude-sonnet-5")).toBe(2_000 + 8_000);
  });

  it("pads Fable even though its adaptiveThinking flag is false (always-on thinking)", () => {
    // The flag means 'don't send the param', not 'doesn't think' — effortControl
    // is the honest discriminator, so Fable is padded like the adaptive models.
    expect(computeEffectiveMaxTokens(2_000, "claude-fable-5", "high")).toBe(2_000 + 24_000);
    expect(computeEffectiveMaxTokens(2_000, "claude-fable-5")).toBe(2_000 + 8_000);
  });

  it("clamps to the model's real max output", () => {
    // Opus/Fable/Sonnet cap at 128k; Haiku at 64k.
    expect(computeEffectiveMaxTokens(120_000, "claude-opus-4-8", "max")).toBe(128_000);
    expect(computeEffectiveMaxTokens(70_000, "claude-haiku-4-5")).toBe(64_000);
    expect(computeEffectiveMaxTokens(60_000, "claude-haiku-4-5")).toBe(60_000);
  });

  it("passes an unknown model through with no pad and no clamp", () => {
    expect(computeEffectiveMaxTokens(1_000, "claude-nonexistent", "high")).toBe(1_000);
  });
});

describe("loud truncation + corrective retry (callStructured)", () => {
  it("warns on a max_tokens stop_reason even when the output still parses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createMock.mockResolvedValueOnce(msg('{"ok":true}', "max_tokens"));

    const out = await callJudgment(DEV_TIER_SELECTION, {
      name: "unit_probe",
      schema: SCHEMA,
      prompt: "x",
      maxTokens: CLASSIFY,
    });

    expect(out).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(1); // parsed → no retry
    expect(warn).toHaveBeenCalledWith(
      "[llm] TRUNCATED at max_tokens",
      expect.objectContaining({
        name: "unit_probe",
        outputBudget: CLASSIFY,
        model: "claude-haiku-4-5",
      }),
    );
  });

  it("doubles the OUTPUT budget exactly once when truncation caused the parse failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    createMock
      .mockResolvedValueOnce(msg('{"ok":', "max_tokens")) // clipped → invalid JSON
      .mockResolvedValueOnce(msg('{"ok":true}', "end_turn")); // retry lands

    const out = await callJudgment(DEV_TIER_SELECTION, {
      name: "unit_probe",
      schema: SCHEMA,
      prompt: "x",
      maxTokens: CLASSIFY,
    });

    expect(out).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    // Haiku adds no pad, so the effective cap IS the output budget: 1k → 2k.
    expect(createMock.mock.calls[0]?.[0].max_tokens).toBe(CLASSIFY);
    expect(createMock.mock.calls[1]?.[0].max_tokens).toBe(CLASSIFY * 2);
  });

  it("does NOT double when the failure was validation, not truncation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    createMock
      .mockResolvedValueOnce(msg('{"ok":"not-a-bool"}', "end_turn")) // parses, fails schema
      .mockResolvedValueOnce(msg('{"ok":true}', "end_turn"));

    await callJudgment(DEV_TIER_SELECTION, {
      name: "unit_probe",
      schema: SCHEMA,
      prompt: "x",
      maxTokens: CLASSIFY,
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    // Same cap on the retry: the doubling is truncation-only.
    expect(createMock.mock.calls[1]?.[0].max_tokens).toBe(CLASSIFY);
  });
});
