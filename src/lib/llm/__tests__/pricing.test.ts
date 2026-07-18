import { describe, expect, it } from "vitest";
import { estimateCostUsd, pricingFor } from "../pricing";

describe("pricing table (2026-07 rates)", () => {
  it("carries the confirmed per-1M rates", () => {
    expect(pricingFor("claude-fable-5")).toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(pricingFor("claude-opus-4-8")).toMatchObject({ inputPer1M: 5, outputPer1M: 25 });
    expect(pricingFor("claude-sonnet-5")).toMatchObject({ inputPer1M: 3, outputPer1M: 15 });
    expect(pricingFor("claude-haiku-4-5")).toMatchObject({ inputPer1M: 1, outputPer1M: 5 });
    expect(pricingFor("voyage-3.5").inputPer1M).toBeCloseTo(0.06);
  });

  it("cache rates follow Anthropic's multipliers (read 0.1×, 1h write 2×)", () => {
    // C9 (2026-07-18): every breakpoint writes at the 1-hour TTL — measured
    // live think-time made the 5m rate (1.25×) a rate this engine never pays.
    for (const model of [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]) {
      const p = pricingFor(model);
      expect(p.cacheReadPer1M).toBeCloseTo(p.inputPer1M * 0.1);
      expect(p.cacheCreationPer1M).toBeCloseTo(p.inputPer1M * 2);
    }
  });

  it("throws on unknown models — the menus are closed", () => {
    expect(() => pricingFor("claude-opus-4-7")).toThrow(/menus are closed/);
  });

  it("estimateCostUsd sums all four buckets", () => {
    const cost = estimateCostUsd("claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 6);
  });

  it("a realistic cached narration turn prices sanely", () => {
    // 12k prompt mostly cache-read + 900 out on Sonnet 5.
    const cost = estimateCostUsd("claude-sonnet-5", {
      input_tokens: 1_000,
      output_tokens: 900,
      cache_read_input_tokens: 11_000,
    });
    expect(cost).toBeCloseTo(0.003 + 0.0135 + 0.0033);
  });
});
