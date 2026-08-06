import { describe, expect, it } from "vitest";
import { IntentOutput, TRIAGE_THRESHOLDS, TURN_CONTRACTS } from "../turn";

describe("TURN_CONTRACTS (§5.1 table)", () => {
  it("budgets are strictly ordered douga < genga < sakuga", () => {
    const { douga, genga, sakuga } = TURN_CONTRACTS;
    expect(douga.outputBudgetTokens).toBeLessThan(genga.outputBudgetTokens);
    expect(genga.outputBudgetTokens).toBeLessThan(sakuga.outputBudgetTokens);
    expect(genga.promptBudgetTokens).toBeLessThanOrEqual(sakuga.promptBudgetTokens);
  });

  it("latency targets are MEASURED, and douga's no longer ladders (flat-high)", () => {
    const { genga, sakuga } = TURN_CONTRACTS;
    // The ladder held while douga ran effort "low". The §3 flatten put the
    // trivial tier on "high", and the N=50 soak (2026-08-05) measured the
    // consequence: douga TTFT p90 102.8s against genga's ~92s — at flat high
    // a trivial prompt gives adaptive thinking nothing to converge on, so the
    // SHALLOWEST tier waits longest. Asserting douga < genga would now assert
    // a target that is known-false, which is how the old 3s target survived
    // long enough to make 28 of one run's 101 latency flags unactionable.
    // Genga < sakuga still ladders and stays asserted; douga is graded against
    // its own measured distribution (types/turn.ts), not against its siblings.
    expect(genga.ttftTargetMs).toBeLessThan(sakuga.ttftTargetMs);
    expect(genga.totalTargetMs).toBeLessThan(sakuga.totalTargetMs);
    // The one ordering that is structural rather than empirical: a turn cannot
    // finish before it starts streaming.
    for (const c of Object.values(TURN_CONTRACTS)) {
      expect(c.ttftTargetMs).toBeLessThan(c.totalTargetMs);
    }
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
