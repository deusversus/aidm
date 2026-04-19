import type { IntentOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { retrievalBudget, shouldPreJudgeOutcome } from "../turn";

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
