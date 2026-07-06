import { describe, expect, it } from "vitest";
import { evalResultPassed, formatResultLine, runDeterministicChecks, summarize } from "./aggregate";
import type { GoldenFixture } from "./types";

/**
 * Harness plumbing tests (Commit 8). Zero LLM calls. Zero DB. Validates
 * the deterministic aggregator logic that the CI gate relies on.
 */

const MIN_FIXTURE: GoldenFixture = {
  id: "test-scenario",
  description: "test",
  profile_slug: "cowboy-bebop",
  character: { name: "Spike", concept: "c", power_tier: "T9", sheet: {} },
  last_turns_summary: "",
  input: { player_message: "hello" },
  expected_intent: {
    intent: "SOCIAL",
    epicness_min: 0.3,
    epicness_max: 0.7,
    special_conditions: [],
  },
  expected_outcome_bounds: {
    narrative_weight_one_of: ["MINOR", "SIGNIFICANT"],
    success_level_one_of: ["partial_success", "success"],
    rationale_non_empty: true,
  },
  expected_narrative_deterministic: {
    must_include_entity: ["Jet", "Julia"],
    must_not_include: ["generic filler"],
    min_length_chars: 100,
    max_length_chars: 2000,
  },
  mockllm_fixture_dir: "evals/fixtures/llm/gameplay/test/",
};

describe("runDeterministicChecks", () => {
  it("passes when every dimension is met", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet sat with Julia in the hangar. ".repeat(10),
    });
    expect(d.intentExact).toBe(true);
    expect(d.epicnessInRange).toBe(true);
    expect(d.outcomeInBounds).toBe(true);
    expect(d.narrativeMustIncludeMissing).toEqual([]);
    expect(d.narrativeMustNotIncludeHit).toEqual([]);
    expect(d.narrativeLengthOk).toBe(true);
    expect(evalResultPassed(d)).toBe(true);
  });

  it("fails on intent mismatch", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "COMBAT", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet and Julia fight. ".repeat(10),
    });
    expect(d.intentExact).toBe(false);
    expect(evalResultPassed(d)).toBe(false);
  });

  it("fails on epicness out of range", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.9, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet and Julia talk. ".repeat(10),
    });
    expect(d.epicnessInRange).toBe(false);
    expect(evalResultPassed(d)).toBe(false);
  });

  it("fails on missing required entity", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Generic narrative that mentions neither. ".repeat(10),
    });
    expect(d.narrativeMustIncludeMissing).toContain("Jet");
    expect(d.narrativeMustIncludeMissing).toContain("Julia");
    expect(evalResultPassed(d)).toBe(false);
  });

  it("fails on forbidden phrase hit", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet and Julia and some generic filler text. ".repeat(10),
    });
    expect(d.narrativeMustNotIncludeHit).toContain("generic filler");
    expect(evalResultPassed(d)).toBe(false);
  });

  it("fails on narrative too short", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "SIGNIFICANT",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet Julia.",
    });
    expect(d.narrativeLengthOk).toBe(false);
  });

  it("fails when outcome expected but absent", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: null,
      narrative: "Jet Julia text ".repeat(10),
    });
    expect(d.outcomeInBounds).toBe(false);
  });

  it("passes when outcome expectations are absent AND outcome is null", () => {
    const skipBounds: GoldenFixture = { ...MIN_FIXTURE, expected_outcome_bounds: undefined };
    const d = runDeterministicChecks(skipBounds, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: null,
      narrative: "Jet Julia text ".repeat(10),
    });
    expect(d.outcomeInBounds).toBe(true);
  });

  it("fails on narrative_weight not in allowed set", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "CLIMACTIC",
        success_level: "partial_success",
        rationale: "ok",
      },
      narrative: "Jet Julia. ".repeat(20),
    });
    expect(d.outcomeInBounds).toBe(false);
  });

  it("fails on success_level not in allowed set", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "MINOR",
        success_level: "critical_failure",
        rationale: "ok",
      },
      narrative: "Jet Julia. ".repeat(20),
    });
    expect(d.outcomeInBounds).toBe(false);
  });

  it("fails on empty rationale when rationale_non_empty required", () => {
    const d = runDeterministicChecks(MIN_FIXTURE, {
      intent: { intent: "SOCIAL", epicness: 0.5, special_conditions: [] },
      outcome: {
        narrative_weight: "MINOR",
        success_level: "partial_success",
        rationale: "   ",
      },
      narrative: "Jet Julia. ".repeat(20),
    });
    expect(d.outcomeInBounds).toBe(false);
  });
});

describe("summarize + formatResultLine", () => {
  it("counts passed/failed correctly", () => {
    const passingResult = {
      id: "a",
      passed: true,
      narrative: "ok",
      deterministic: {
        intentExact: true,
        intentActual: "SOCIAL",
        epicnessActual: 0.5,
        epicnessInRange: true,
        outcomeInBounds: true,
        outcomeNarrativeWeight: null,
        outcomeSuccessLevel: null,
        narrativeMustIncludeMissing: [],
        narrativeMustNotIncludeHit: [],
        narrativeLengthOk: true,
        narrativeLength: 100,
      },
    };
    const failingResult = { ...passingResult, id: "b", passed: false };
    const summary = summarize("ci", [passingResult, failingResult]);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.mode).toBe("ci");
    expect(summary.ranAt).toBeTruthy();
  });

  it("formatResultLine includes failure reason in line", () => {
    const line = formatResultLine({
      id: "x",
      passed: false,
      narrative: "",
      deterministic: {
        intentExact: false,
        intentActual: "COMBAT",
        epicnessActual: 0.5,
        epicnessInRange: true,
        outcomeInBounds: true,
        outcomeNarrativeWeight: null,
        outcomeSuccessLevel: null,
        narrativeMustIncludeMissing: [],
        narrativeMustNotIncludeHit: [],
        narrativeLengthOk: true,
        narrativeLength: 500,
      },
    });
    expect(line).toContain("[FAIL]");
    expect(line).toContain("x");
    expect(line).toContain("intent:COMBAT");
  });
});

describe("--judge CI guard (judge.ts)", () => {
  it("throws when process.env.CI === 'true'", async () => {
    const original = process.env.CI;
    process.env.CI = "true";
    try {
      const { judgeScenario } = await import("./judge");
      await expect(judgeScenario(MIN_FIXTURE, "some narrative")).rejects.toThrow(
        /refusing to run in CI/,
      );
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "CI");
      else process.env.CI = original;
    }
  });
});
