import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WARN_FRACTIONS,
  dayBucketKey,
  getWarnThresholds,
  minuteBucketKey,
  nextMidnightUtcIso,
  secondsUntilNextMinute,
} from "../config";

describe("budget/config", () => {
  describe("bucket keys", () => {
    it("minute bucket key is YYYY-MM-DDTHH:MMZ UTC", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 15, 42, 37, 500));
      expect(minuteBucketKey(d)).toBe("2026-04-22T15:42Z");
    });

    it("minute bucket drops seconds and ms", () => {
      const a = new Date(Date.UTC(2026, 3, 22, 15, 42, 0, 0));
      const b = new Date(Date.UTC(2026, 3, 22, 15, 42, 59, 999));
      expect(minuteBucketKey(a)).toBe(minuteBucketKey(b));
    });

    it("day bucket key is YYYY-MM-DD UTC", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 23, 59, 59, 999));
      expect(dayBucketKey(d)).toBe("2026-04-22");
    });

    it("day bucket rolls at UTC midnight", () => {
      const beforeMidnight = new Date(Date.UTC(2026, 3, 22, 23, 59, 59, 999));
      const afterMidnight = new Date(Date.UTC(2026, 3, 23, 0, 0, 0, 0));
      expect(dayBucketKey(beforeMidnight)).toBe("2026-04-22");
      expect(dayBucketKey(afterMidnight)).toBe("2026-04-23");
    });
  });

  describe("retry-after helpers", () => {
    it("secondsUntilNextMinute is 60 at the top of a minute", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 15, 42, 0, 0));
      expect(secondsUntilNextMinute(d)).toBe(60);
    });

    it("secondsUntilNextMinute is 1 at 59.001s", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 15, 42, 59, 1));
      expect(secondsUntilNextMinute(d)).toBe(1);
    });

    it("nextMidnightUtcIso rolls forward one day from mid-day", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 15, 42, 0));
      expect(nextMidnightUtcIso(d)).toBe("2026-04-23T00:00:00.000Z");
    });

    it("nextMidnightUtcIso still rolls forward from 23:59:59", () => {
      const d = new Date(Date.UTC(2026, 3, 22, 23, 59, 59, 999));
      expect(nextMidnightUtcIso(d)).toBe("2026-04-23T00:00:00.000Z");
    });
  });

  describe("warn thresholds + rate cap", () => {
    it("WARN_FRACTIONS is [0.5, 0.9]", () => {
      expect(WARN_FRACTIONS).toEqual([0.5, 0.9]);
    });

    it("getWarnThresholds returns the canonical tuple", () => {
      expect(getWarnThresholds()).toEqual([0.5, 0.9]);
    });
  });

  describe("getTurnRateCap (env-backed)", () => {
    const originalEnv = process.env;
    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv, DATABASE_URL: "postgres://u:p@h:5432/d" };
    });
    afterEach(() => {
      process.env = originalEnv;
    });

    it("defaults to 6 when AIDM_TURNS_PER_MINUTE_CAP is unset", async () => {
      Reflect.deleteProperty(process.env, "AIDM_TURNS_PER_MINUTE_CAP");
      const { getTurnRateCap } = await import("../config");
      expect(getTurnRateCap()).toBe(6);
    });

    it("respects AIDM_TURNS_PER_MINUTE_CAP override", async () => {
      process.env.AIDM_TURNS_PER_MINUTE_CAP = "12";
      const { getTurnRateCap } = await import("../config");
      expect(getTurnRateCap()).toBe(12);
    });

    it("rejects non-numeric AIDM_TURNS_PER_MINUTE_CAP at first access", async () => {
      process.env.AIDM_TURNS_PER_MINUTE_CAP = "banana";
      const { getTurnRateCap } = await import("../config");
      expect(() => getTurnRateCap()).toThrow();
    });
  });
});
