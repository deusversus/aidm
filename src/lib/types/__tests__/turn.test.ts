import { describe, expect, it } from "vitest";
import { IntentOutput, TRIAGE_THRESHOLDS, TURN_CONTRACTS } from "../turn";

describe("TURN_CONTRACTS (§5.1 table)", () => {
  it("budgets are strictly ordered douga < genga < sakuga", () => {
    const { douga, genga, sakuga } = TURN_CONTRACTS;
    expect(douga.outputBudgetTokens).toBeLessThan(genga.outputBudgetTokens);
    expect(genga.outputBudgetTokens).toBeLessThan(sakuga.outputBudgetTokens);
    expect(douga.ttftTargetMs).toBeLessThan(genga.ttftTargetMs);
    expect(genga.ttftTargetMs).toBeLessThan(sakuga.ttftTargetMs);
    expect(douga.totalTargetMs).toBeLessThan(genga.totalTargetMs);
    expect(genga.totalTargetMs).toBeLessThan(sakuga.totalTargetMs);
    expect(genga.promptBudgetTokens).toBeLessThanOrEqual(sakuga.promptBudgetTokens);
  });

  it("douga is the no-machinery tier: no retrieval, no consultants, no research", () => {
    const { douga } = TURN_CONTRACTS;
    expect(douga.retrievalCandidates).toBe(0);
    expect(douga.consultants).toEqual([]);
    expect(douga.kaResearchCalls).toBe(0);
    expect(douga.canonFanOut).toBe(false);
  });

  it("effort is FLAT at high across all tiers (§3 amendment, user-ruled 2026-08-01)", () => {
    // Effort is part of the prompt-cache key (wire-measured): the old ladder
    // cold-opened every tier boundary. One value, one key, every turn warm.
    expect(TURN_CONTRACTS.douga.effort).toBe("high");
    expect(TURN_CONTRACTS.genga.effort).toBe("high");
    expect(TURN_CONTRACTS.sakuga.effort).toBe("high");
  });

  it("only sakuga carries the validation retry and canon fan-out", () => {
    expect(TURN_CONTRACTS.sakuga.validationRetry).toBe(true);
    expect(TURN_CONTRACTS.sakuga.canonFanOut).toBe(true);
    expect(TURN_CONTRACTS.genga.validationRetry).toBe(false);
    expect(TURN_CONTRACTS.douga.validationRetry).toBe(false);
  });

  it("triage thresholds leave a genga band between them", () => {
    expect(TRIAGE_THRESHOLDS.dougaMaxEpicness).toBeLessThan(TRIAGE_THRESHOLDS.sakugaMinEpicness);
  });

  it("retrieval caps respect the prescription budget (≤5 into the conte)", () => {
    for (const contract of Object.values(TURN_CONTRACTS)) {
      expect(contract.retrievalCap).toBeLessThanOrEqual(5);
    }
  });
});

describe("IntentOutput (salvaged null-coercion behavior)", () => {
  it("coerces null target/action to undefined instead of failing parse", () => {
    const parsed = IntentOutput.parse({
      intent: "DEFAULT",
      target: null,
      action: null,
      epicness: 0.3,
      confidence: 0.8,
    });
    expect(parsed.target).toBeUndefined();
    expect(parsed.action).toBeUndefined();
    expect(parsed.special_conditions).toEqual([]);
  });
});
