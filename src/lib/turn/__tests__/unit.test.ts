import type { IntentOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { LADDER_STEPS, createDegradeClock } from "../degrade";
import { rollD20, successBand, sumModifiers } from "../dice";
import {
  SCALE_COMPATIBILITY,
  imbalanceBand,
  imbalanceFlags,
  opModeActive,
  powerContext,
  powerDifferential,
  rawPowerRatio,
  tierBand,
} from "../power";
import { CATEGORY_DECAY, DECAY_CURVES, computeHeat, decomposeQueries } from "../retrieval";
import { classifyTier, isChannelInput } from "../triage";

const intent = (over: Partial<IntentOutput>): IntentOutput => ({
  intent: "DEFAULT",
  epicness: 0.4,
  special_conditions: [],
  confidence: 0.9,
  ...over,
});

describe("dice", () => {
  it("success bands carry v3's ladder onto the v5 enum", () => {
    expect(successBand(1, 25, 10)).toBe("critical_failure"); // nat 1 trumps all
    expect(successBand(20, 21, 30)).toBe("critical_success"); // nat 20 trumps DC
    expect(successBand(12, 25, 15)).toBe("critical_success"); // DC+10
    expect(successBand(12, 17, 15)).toBe("success");
    expect(successBand(12, 12, 15)).toBe("partial_success"); // DC-4 band
    expect(successBand(5, 8, 15)).toBe("failure");
  });

  it("modifier strings sum by their leading signed integer; noise counts zero", () => {
    expect(sumModifiers(["+2 High Ground", "+5 Friendship Power", "-3 Injured"])).toBe(4);
    expect(sumModifiers(["+10 Vastly Overpowered"])).toBe(10);
    expect(sumModifiers(["the wind favors you"])).toBe(0);
    expect(sumModifiers([])).toBe(0);
  });

  it("advantage takes the higher face, disadvantage the lower", () => {
    const seq = [0.9, 0.1]; // faces 19, 3
    let i = 0;
    const rng = () => seq[i++ % 2] as number;
    i = 0;
    expect(rollD20("advantage", rng).natural).toBe(19);
    i = 0;
    expect(rollD20("disadvantage", rng).natural).toBe(3);
  });
});

describe("triage (§5.1 thresholds)", () => {
  it("douga: low epicness, unflagged, non-routed intents only", () => {
    expect(classifyTier(intent({ epicness: 0.1 }))).toBe("douga");
    expect(classifyTier(intent({ epicness: 0.1, intent: "SOCIAL" }))).toBe("genga");
    expect(classifyTier(intent({ epicness: 0.1, intent: "ABILITY" }))).toBe("genga");
    expect(classifyTier(intent({ epicness: 0.1, special_conditions: ["named_attack"] }))).toBe(
      "sakuga",
    );
  });
  it("sakuga: combat, flags, or epicness ≥ 0.7", () => {
    expect(classifyTier(intent({ intent: "COMBAT", epicness: 0.1 }))).toBe("sakuga");
    expect(classifyTier(intent({ epicness: 0.75 }))).toBe("sakuga");
    expect(classifyTier(intent({ epicness: 0.69 }))).toBe("genga");
  });
  it("channel inputs route out of the story pipeline (§5.4)", () => {
    expect(isChannelInput(intent({ intent: "META_FEEDBACK" }))).toBe(true);
    expect(isChannelInput(intent({ intent: "OVERRIDE_COMMAND" }))).toBe(true);
    expect(isChannelInput(intent({ intent: "WORLD_BUILDING" }))).toBe(false);
  });
});

describe("power: the OP-premise table (§5.1 DC floor)", () => {
  // The table: character tier vs world baseline → OP mode. Lower T = stronger.
  const cases: [number, number, boolean][] = [
    [4, 7, true], // 3 tiers above baseline — the floor engages
    [2, 7, true], // 5 above — deep OP
    [5, 7, false], // 2 above — strong, not OP
    [7, 7, false], // at baseline
    [9, 7, false], // below baseline
    [1, 10, true], // boundless in a human world
  ];
  for (const [char, world, op] of cases) {
    it(`T${char} vs baseline T${world} → OP=${op}`, () => {
      expect(opModeActive(char, world)).toBe(op);
      expect(powerDifferential(char, world)).toBe(world - char);
    });
  }
  it("power context names OP mode and the trivial-DC rule", () => {
    expect(powerContext(3, 7)).toContain("OP MODE ACTIVE");
    expect(powerContext(3, 7)).toContain("DC 5");
    expect(powerContext(9, 5)).toContain("BELOW world baseline");
    expect(powerContext(undefined, 7)).toBe("");
  });
  it("tier bands match v3's ladder", () => {
    expect(tierBand(10)).toBe("human");
    expect(tierBand(7)).toBe("superhuman");
    expect(tierBand(5)).toBe("planetary");
    expect(tierBand(1)).toBe("boundless");
  });
});

describe("scale/imbalance (Module 12)", () => {
  it("raw ratio is v3's LINEAR inverted-tier math, not exponential", () => {
    expect(rawPowerRatio(5, 7)).toBeCloseTo(5 / 3); // T5 vs T7 → 5/3
    expect(rawPowerRatio(7, 5)).toBeCloseTo(3 / 5);
    expect(rawPowerRatio(7, 7)).toBe(1);
    expect(rawPowerRatio(5, 10)).toBe(10); // vs the powerless: pc × 2 (v3)
    expect(rawPowerRatio(10, 10)).toBe(0); // both powerless → balanced band
  });
  it("bands at v3 thresholds", () => {
    expect(imbalanceBand(1.2)).toBe("balanced");
    expect(imbalanceBand(2.5)).toBe("moderate");
    expect(imbalanceBand(8)).toBe("significant");
    expect(imbalanceBand(16)).toBe("overwhelming");
  });
  it("flags: OP framing >10×, tension shift >3×", () => {
    expect(imbalanceFlags(16)).toEqual({ triggersOpMode: true, triggersTensionShift: true });
    expect(imbalanceFlags(5)).toEqual({ triggersOpMode: false, triggersTensionShift: true });
    expect(imbalanceFlags(1.1)).toEqual({ triggersOpMode: false, triggersTensionShift: false });
  });
  it("the compatibility matrix carries v3's hard edges", () => {
    expect(SCALE_COMPATIBILITY.human.spectacle).toBe("FORBIDDEN");
    expect(SCALE_COMPATIBILITY.planetary.underdog).toBe("FORBIDDEN");
    expect(SCALE_COMPATIBILITY.boundless.mystery).toBe("FORBIDDEN");
    expect(SCALE_COMPATIBILITY.superhuman.underdog).toBe("OK");
  });
});

describe("degrade ladder (§5.5)", () => {
  it("escalation is proportional: a mildly-late turn fires ONE rung, never the terminal ones", () => {
    let clock = 0;
    const fired: string[] = [];
    const ladder = createDegradeClock(
      100,
      (s) => fired.push(s),
      () => clock,
    );
    clock = 110; // 1.1× budget
    while (ladder.shouldDegrade()) ladder.fire();
    expect(fired).toEqual(["skip_validation_retry"]);
    expect(ladder.state.degraded).toBe(false);
    clock = 150; // 1.5× — two more rungs cross
    while (ladder.shouldDegrade()) ladder.fire();
    expect(fired).toEqual(["skip_validation_retry", "timebox_pacer", "cap_research_2"]);
    expect(ladder.state.degraded).toBe(false);
  });
  it("a catastrophic stall reaches the §5.5 terminal fallback in order", () => {
    let clock = 0;
    const fired: string[] = [];
    const ladder = createDegradeClock(
      100,
      (s) => fired.push(s),
      () => clock,
    );
    clock = 250; // 2.5× budget
    while (ladder.shouldDegrade()) ladder.fire();
    expect(fired).toEqual([...LADDER_STEPS]);
    expect(ladder.state.degraded).toBe(true);
    expect(ladder.fire()).toBeNull(); // exhausted
  });
  it("within budget, nothing fires and the brief is clean", () => {
    const ladder = createDegradeClock(
      10_000,
      () => {},
      () => 0,
    );
    expect(ladder.shouldDegrade()).toBe(false);
    expect(ladder.state.degraded).toBe(false);
  });
});

describe("intent probe null tolerance (live-probe regression)", () => {
  it("secondary_intent/target/action null coerce to undefined", async () => {
    const { IntentOutput } = await import("@/lib/types/turn");
    const parsed = IntentOutput.parse({
      intent: "EXPLORATION",
      target: null,
      action: null,
      epicness: 0.4,
      special_conditions: [],
      confidence: 0.9,
      secondary_intent: null,
    });
    expect(parsed.secondary_intent).toBeUndefined();
    expect(parsed.target).toBeUndefined();
  });
});

describe("heat economy (§6.4, v3 curves)", () => {
  it("computeHeat decays per turn on the category curve with a floor", () => {
    const row = {
      baseHeat: 100,
      heatFloor: 1,
      category: "episode",
      plotCritical: false,
      lastBoostedTurn: 0,
    };
    expect(computeHeat(row, 0)).toBe(100);
    expect(computeHeat(row, 1)).toBeCloseTo(70);
    expect(computeHeat(row, 6)).toBeCloseTo(100 * 0.7 ** 6);
    expect(computeHeat(row, 100)).toBe(1); // floored
  });
  it("plot-critical rows never decay; core/session_zero categories neither", () => {
    const pc = {
      baseHeat: 80,
      heatFloor: 1,
      category: "event",
      plotCritical: true,
      lastBoostedTurn: 0,
    };
    expect(computeHeat(pc, 50)).toBe(80);
    const core = {
      baseHeat: 80,
      heatFloor: 1,
      category: "core",
      plotCritical: false,
      lastBoostedTurn: 0,
    };
    expect(computeHeat(core, 50)).toBe(80);
  });
  it("all 15 v3 categories have curves", () => {
    expect(Object.keys(CATEGORY_DECAY)).toHaveLength(15);
    for (const curve of Object.values(CATEGORY_DECAY)) {
      expect(DECAY_CURVES[curve]).toBeDefined();
    }
  });
});

describe("multi-query decomposition (≤3, v3 shape)", () => {
  it("action + situation + entity, deduped, capped at 3", () => {
    const qs = decomposeQueries(
      intent({ action: "confront", target: "Milia" }),
      "I confront Milia",
      "the guild hall after the announcement",
    );
    expect(qs).toHaveLength(3);
    expect(qs[0]).toBe("confront Milia");
    expect(qs[2]).toContain("relationship history");
  });
  it("falls back to raw input when the probe gave nothing", () => {
    expect(decomposeQueries(intent({}), "look around")).toEqual(["look around"]);
  });
});
