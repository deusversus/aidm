import { describe, expect, it } from "vitest";
import { estimateCostUsd, pricingFor } from "../pricing";
import {
  appearsToWantStructuredOutput,
  synthesizeAnthropicResponse,
  synthesizeCostUsd,
} from "../synth";
import type { RequestSignature } from "../types";

function sig(overrides: Partial<RequestSignature> = {}): RequestSignature {
  return {
    provider: "anthropic",
    endpoint: "/v1/messages",
    model: "claude-opus-4-7",
    system: "You are a test agent",
    messages: [{ role: "user", text: "Respond please." }],
    toolNames: [],
    streaming: false,
    rawBody: {},
    ...overrides,
  };
}

describe("appearsToWantStructuredOutput", () => {
  it("detects the canonical 'Return the JSON object now' marker", () => {
    const s = sig({
      messages: [{ role: "user", text: "Return the JSON object now." }],
    });
    expect(appearsToWantStructuredOutput(s)).toBe(true);
  });

  it("returns false when marker is absent", () => {
    const s = sig({ messages: [{ role: "user", text: "Tell me a story." }] });
    expect(appearsToWantStructuredOutput(s)).toBe(false);
  });

  it("detects marker mid-message", () => {
    const s = sig({
      messages: [{ role: "user", text: "Here is my intent:\n\nReturn the JSON object now" }],
    });
    expect(appearsToWantStructuredOutput(s)).toBe(true);
  });
});

describe("synthesizeAnthropicResponse", () => {
  it("produces '{}' when structured output is wanted (Zod parse-safe)", () => {
    const resp = synthesizeAnthropicResponse(
      sig({ messages: [{ role: "user", text: "Return the JSON object now" }] }),
    );
    expect(resp.content[0]?.type).toBe("text");
    if (resp.content[0]?.type === "text") {
      expect(resp.content[0].text).toBe("{}");
    }
  });

  it("produces self-identifying narrative for non-structured prompts", () => {
    const resp = synthesizeAnthropicResponse(sig({ model: "claude-opus-4-7" }));
    if (resp.content[0]?.type === "text") {
      expect(resp.content[0].text).toMatch(/mock narrative/);
      expect(resp.content[0].text).toContain("claude-opus-4-7");
    }
  });

  it("emits plausible usage stats scaled to prompt length", () => {
    const long = "x".repeat(4000);
    const resp = synthesizeAnthropicResponse(sig({ system: long }));
    // 4000 chars / 4 ≈ 1000 input tokens
    expect(resp.usage.input_tokens).toBeGreaterThanOrEqual(900);
    expect(resp.usage.input_tokens).toBeLessThanOrEqual(1100);
    expect(resp.usage.output_tokens).toBeGreaterThan(0);
  });

  it("sets stop_reason to end_turn", () => {
    const resp = synthesizeAnthropicResponse(sig());
    expect(resp.stop_reason).toBe("end_turn");
  });

  it("echoes the requested model", () => {
    const resp = synthesizeAnthropicResponse(sig({ model: "claude-haiku-4-5-20251001" }));
    expect(resp.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("pricing — hardcoded table", () => {
  it("knows Opus 4.7", () => {
    const p = pricingFor("claude-opus-4-7");
    expect(p.inputPer1M).toBe(15);
    expect(p.outputPer1M).toBe(75);
  });

  it("knows Haiku", () => {
    const p = pricingFor("claude-haiku-4-5-20251001");
    expect(p.inputPer1M).toBe(0.25);
  });

  it("falls back for unknown models", () => {
    const p = pricingFor("made-up-model-name");
    expect(p.inputPer1M).toBeGreaterThan(0);
  });

  it("cache_read is 90% discount on Anthropic", () => {
    const p = pricingFor("claude-opus-4-7");
    expect(p.cacheReadPer1M).toBeCloseTo(p.inputPer1M * 0.1, 2);
  });
});

describe("estimateCostUsd", () => {
  it("computes simple input+output cost", () => {
    // Opus 4.7: $15/M input, $75/M output
    // 1000 input + 500 output = 15/1000 + 75/2000 = 0.015 + 0.0375 = 0.0525
    const cost = estimateCostUsd("claude-opus-4-7", {
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(cost).toBeCloseTo(0.0525, 4);
  });

  it("factors cache_read_input_tokens at discounted rate", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      input_tokens: 1000,
      output_tokens: 0,
      cache_read_input_tokens: 10000,
    });
    // 1000 * 15/1M + 10000 * 1.5/1M = 0.015 + 0.015 = 0.030
    expect(cost).toBeCloseTo(0.03, 4);
  });

  it("factors cache_creation_input_tokens at premium rate", () => {
    const cost = estimateCostUsd("claude-opus-4-7", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1000,
    });
    // 1000 * 18.75/1M = 0.01875
    expect(cost).toBeCloseTo(0.01875, 5);
  });
});

describe("synthesizeCostUsd", () => {
  it("reads model + usage off response to compute cost", () => {
    const resp = synthesizeAnthropicResponse(
      sig({ model: "claude-opus-4-7", system: "x".repeat(4000) }),
    );
    const cost = synthesizeCostUsd(resp);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1); // sanity — not a million-dollar mock
  });
});
