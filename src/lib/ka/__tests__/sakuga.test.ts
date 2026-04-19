import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { selectSakugaMode } from "../sakuga";

function intent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    intent: "DEFAULT",
    epicness: 0.4,
    special_conditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

function outcome(weight: "MINOR" | "SIGNIFICANT" | "CLIMACTIC"): OutcomeOutput {
  return {
    success_level: "success",
    difficulty_class: 12,
    modifiers: [],
    narrative_weight: weight,
    rationale: "test",
  };
}

describe("selectSakugaMode", () => {
  describe("priority ladder", () => {
    it("first_time_power → frozen_moment (top of ladder)", () => {
      const s = selectSakugaMode(
        intent({ special_conditions: ["first_time_power"] }),
        outcome("MINOR"),
      );
      expect(s?.mode).toBe("frozen_moment");
      expect(s?.reason).toContain("first_time_power");
    });

    it("protective_rage → frozen_moment", () => {
      const s = selectSakugaMode(intent({ special_conditions: ["protective_rage"] }), undefined);
      expect(s?.mode).toBe("frozen_moment");
    });

    it("named_attack → choreographic", () => {
      const s = selectSakugaMode(intent({ special_conditions: ["named_attack"] }), undefined);
      expect(s?.mode).toBe("choreographic");
    });

    it("underdog_moment → choreographic", () => {
      const s = selectSakugaMode(intent({ special_conditions: ["underdog_moment"] }), undefined);
      expect(s?.mode).toBe("choreographic");
    });

    it("power_of_friendship → choreographic", () => {
      const s = selectSakugaMode(
        intent({ special_conditions: ["power_of_friendship"] }),
        undefined,
      );
      expect(s?.mode).toBe("choreographic");
    });

    it("training_payoff → montage", () => {
      const s = selectSakugaMode(intent({ special_conditions: ["training_payoff"] }), undefined);
      expect(s?.mode).toBe("montage");
    });

    it("ladder order: first_time_power beats named_attack when both present", () => {
      const s = selectSakugaMode(
        intent({ special_conditions: ["named_attack", "first_time_power"] }),
        undefined,
      );
      expect(s?.mode).toBe("frozen_moment");
    });
  });

  describe("fallback path", () => {
    it("CLIMACTIC + SOCIAL → frozen_moment", () => {
      const s = selectSakugaMode(
        intent({ intent: "SOCIAL", special_conditions: [] }),
        outcome("CLIMACTIC"),
      );
      expect(s?.mode).toBe("frozen_moment");
      expect(s?.reason).toContain("fallback");
    });

    it("CLIMACTIC + COMBAT → choreographic", () => {
      const s = selectSakugaMode(
        intent({ intent: "COMBAT", special_conditions: [] }),
        outcome("CLIMACTIC"),
      );
      expect(s?.mode).toBe("choreographic");
    });

    it("CLIMACTIC + DEFAULT → choreographic", () => {
      const s = selectSakugaMode(intent({ special_conditions: [] }), outcome("CLIMACTIC"));
      expect(s?.mode).toBe("choreographic");
    });
  });

  describe("skip path", () => {
    it("MINOR weight with no special conditions → null (no sakuga)", () => {
      expect(selectSakugaMode(intent(), outcome("MINOR"))).toBeNull();
    });

    it("SIGNIFICANT weight with no special conditions → null", () => {
      expect(selectSakugaMode(intent(), outcome("SIGNIFICANT"))).toBeNull();
    });

    it("No outcome + no special conditions → null (Tier-0 fast-path case)", () => {
      expect(selectSakugaMode(intent(), undefined)).toBeNull();
    });
  });

  describe("fragment content", () => {
    it("returns the rendered fragment for the selected mode", () => {
      const s = selectSakugaMode(intent({ special_conditions: ["first_time_power"] }), undefined);
      expect(s?.fragment).toContain("SAKUGA MODE ACTIVE");
      expect(s?.fragment).toContain("Frozen Moment");
    });
  });
});
