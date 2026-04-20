import type { IntentOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { resolveModelContext, retrievalBudget, shouldPreJudgeOutcome } from "../turn";

function intent(partial: Partial<IntentOutput>): IntentOutput {
  return {
    intent: "DEFAULT",
    epicness: 0.2,
    special_conditions: [],
    confidence: 0.9,
    ...partial,
  };
}

describe("retrievalBudget (§9 tiered memory)", () => {
  it("returns 0 for low-stakes turns (epicness < 0.25)", () => {
    expect(retrievalBudget(0)).toBe(0);
    expect(retrievalBudget(0.1)).toBe(0);
    expect(retrievalBudget(0.249)).toBe(0);
  });

  it("returns 3 for mid-low turns (0.25 ≤ epicness < 0.5)", () => {
    expect(retrievalBudget(0.25)).toBe(3);
    expect(retrievalBudget(0.4)).toBe(3);
    expect(retrievalBudget(0.499)).toBe(3);
  });

  it("returns 6 for mid-high turns (0.5 ≤ epicness < 0.75)", () => {
    expect(retrievalBudget(0.5)).toBe(6);
    expect(retrievalBudget(0.7)).toBe(6);
    expect(retrievalBudget(0.749)).toBe(6);
  });

  it("returns 9 for pivotal turns (epicness ≥ 0.75)", () => {
    expect(retrievalBudget(0.75)).toBe(9);
    expect(retrievalBudget(0.9)).toBe(9);
    expect(retrievalBudget(1.0)).toBe(9);
  });
});

describe("resolveModelContext", () => {
  it("falls back to Anthropic when settings is empty (legacy pre-migration row)", () => {
    const ctx = resolveModelContext({});
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.tier_models.creative).toBe("claude-opus-4-7");
  });

  it("falls back to Anthropic when settings is null / undefined", () => {
    const ctx = resolveModelContext(null);
    expect(ctx.provider).toBe("anthropic");
  });

  it("falls back when settings lacks provider or tier_models (half-migrated)", () => {
    const ctx = resolveModelContext({ provider: "anthropic" }); // missing tier_models
    expect(ctx.provider).toBe("anthropic"); // default Anthropic fallback
    expect(ctx.tier_models).toBeDefined();
  });

  it("returns parsed config when fully populated", () => {
    const settings = {
      active_dna: {},
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101", // snapshot pin
        creative: "claude-sonnet-4-6", // cost-down creative
      },
    };
    const ctx = resolveModelContext(settings);
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.tier_models.thinking).toBe("claude-opus-4-5-20251101");
    expect(ctx.tier_models.creative).toBe("claude-sonnet-4-6");
  });

  it("throws when the config is syntactically valid but targets an unavailable provider", () => {
    const settings = {
      provider: "google" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    expect(() => resolveModelContext(settings)).toThrow(/M3\.5/);
  });

  it("throws when the model string isn't in the provider's roster", () => {
    const settings = {
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-99-fake",
        creative: "claude-opus-4-7",
      },
    };
    expect(() => resolveModelContext(settings)).toThrow(/roster|not offer/i);
  });

  it("falls back to Anthropic when settings parse fails entirely (malformed payload)", () => {
    // Anything that doesn't match CampaignSettings fails safeParse; resolver
    // falls back rather than blowing up the turn.
    const ctx = resolveModelContext({ overrides: "not-an-array" });
    expect(ctx.provider).toBe("anthropic");
  });
});

describe("shouldPreJudgeOutcome", () => {
  it("fires for COMBAT regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "COMBAT", epicness: 0.1 }))).toBe(true);
    expect(shouldPreJudgeOutcome(intent({ intent: "COMBAT", epicness: 0.9 }))).toBe(true);
  });

  it("fires for ABILITY regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "ABILITY", epicness: 0.1 }))).toBe(true);
  });

  it("fires for SOCIAL only when epicness ≥ 0.4", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "SOCIAL", epicness: 0.3 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "SOCIAL", epicness: 0.4 }))).toBe(true);
  });

  it("fires for EXPLORATION only when epicness ≥ 0.6", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "EXPLORATION", epicness: 0.5 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "EXPLORATION", epicness: 0.6 }))).toBe(true);
  });

  it("skips INVENTORY / OP_COMMAND regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "INVENTORY", epicness: 0.9 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "OP_COMMAND", epicness: 0.9 }))).toBe(false);
  });

  it("skips low-stakes DEFAULT but fires at epicness ≥ 0.6", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "DEFAULT", epicness: 0.4 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "DEFAULT", epicness: 0.6 }))).toBe(true);
  });
});
