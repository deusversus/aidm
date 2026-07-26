import { describe, expect, it } from "vitest";
import { estimateCostUsd, pricingFor } from "../pricing";

describe("pricing table (2026-07 rates)", () => {
  it("carries the confirmed per-1M rates", () => {
    expect(pricingFor("claude-fable-5")).toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(pricingFor("claude-opus-5")).toMatchObject({ inputPer1M: 5, outputPer1M: 25 });
    // Off-menu since 2026-07-25; kept for historical rows and fixtures.
    expect(pricingFor("claude-opus-4-8")).toMatchObject({ inputPer1M: 5, outputPer1M: 25 });
    expect(pricingFor("claude-sonnet-5")).toMatchObject({ inputPer1M: 3, outputPer1M: 15 });
    expect(pricingFor("claude-haiku-4-5")).toMatchObject({ inputPer1M: 1, outputPer1M: 5 });
    expect(pricingFor("voyage-3.5").inputPer1M).toBeCloseTo(0.06);
  });

  it("cache rates follow Anthropic's multipliers (read 0.1×, 5m write 1.25×, 1h write 2×)", () => {
    // Inter-turn breakpoints all write at 1h (C9, 2026-07-18: no live gap fits
    // 5 minutes); the 5m rate came back with M2R5 C2's in-process loops.
    for (const model of [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]) {
      const p = pricingFor(model);
      expect(p.cacheReadPer1M).toBeCloseTo(p.inputPer1M * 0.1);
      expect(p.cacheCreation5mPer1M).toBeCloseTo(p.inputPer1M * 1.25);
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

  it("prices the per-TTL creation split when the API reports one (M2R5 C2)", () => {
    // 5m only: 1.25×, not the 2× the flat path would have charged.
    expect(
      estimateCostUsd("claude-haiku-4-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
      }),
    ).toBeCloseTo(1.25);

    // 1h only: unchanged from the flat path.
    expect(
      estimateCostUsd("claude-haiku-4-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ).toBeCloseTo(2);

    // Mixed — the split is authoritative, not the flat total beside it.
    expect(
      estimateCostUsd("claude-sonnet-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 400_000,
          ephemeral_1h_input_tokens: 600_000,
        },
      }),
    ).toBeCloseTo(0.4 * 3.75 + 0.6 * 6);
  });

  it("falls back to the flat 1h rate when no split is reported (old rows, fixtures)", () => {
    const cost = estimateCostUsd("claude-haiku-4-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    // Absent means UNKNOWN, not zero — over-estimating beats inventing a discount.
    expect(cost).toBeCloseTo(2);
  });

  it("distrusts a split that is partial or disagrees with the flat total (C2 audit)", () => {
    // The streamed path updates the flat counter from message_delta but never
    // the nested split — a drifted split loses to flat, never wins silently.
    expect(
      estimateCostUsd("claude-haiku-4-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 },
      }),
    ).toBeCloseTo(2);

    // A partial split (undefined sub-field) must yield the flat price, never
    // NaN — NaN doesn't misprice the row, it throws at insert and LOSES it.
    const partial = estimateCostUsd("claude-haiku-4-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: undefined,
        ephemeral_1h_input_tokens: 1_000_000,
      } as unknown as { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number },
    });
    expect(Number.isNaN(partial)).toBe(false);
    expect(partial).toBeCloseTo(2);
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
