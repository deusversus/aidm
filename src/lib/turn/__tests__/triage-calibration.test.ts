import type { IntentOutput } from "@/lib/types/turn";
import { TRIAGE_THRESHOLDS } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { classifyTier } from "../triage";

/**
 * C9 douga calibration — the hand-labeled set (39 live+soak turns with
 * persisted epicness, labeled 2026-07-18). The finding: the probe's emitted
 * floor was 0.2 and douga required <0.2, so douga NEVER fired — the
 * routine-beat class (ash-tap, rain-watching; 12 of 39 turns) all routed
 * genga. The seed case: soak turn 12, "I light a cigarette and watch the
 * rain slide down the viewport", emitted 0.3, labeled douga.
 *
 * The label table below carries REAL emitted epicness from the corpus;
 * expectations encode the calibrated behavior at dougaMaxEpicness 0.3
 * (with the INTENT_SYSTEM anchors teaching the routine class toward
 * 0.1-0.2, so the seed case's future siblings emit below the line).
 */

const intent = (epicness: number, over: Partial<IntentOutput> = {}): IntentOutput => ({
  intent: "DEFAULT",
  epicness,
  special_conditions: [],
  contains_world_assertion: false,
  confidence: 0.9,
  ...over,
});

describe("triage calibration (C9 labeled set)", () => {
  it("the routine-beat class (emitted 0.2-0.25 live) routes douga", () => {
    // "I lean against the frame and watch the smoke curl" — 0.2
    expect(classifyTier(intent(0.2))).toBe("douga");
    // "I light a cigarette. The smoke curls up into nothing." — 0.25
    expect(classifyTier(intent(0.25))).toBe("douga");
    // Just under the line.
    expect(classifyTier(intent(0.29))).toBe("douga");
  });

  it("the mixed 0.3 band stays genga — substantive turns emit 0.3 too", () => {
    // Live at 0.3: a multi-paragraph character-study turn (RBD t3), a bare
    // "continue" carrying a full scene, and the cigarette seed case all
    // emitted 0.3 — the band is ambiguous, so it keeps full craft.
    expect(classifyTier(intent(0.3))).toBe("genga");
    expect(classifyTier(intent(0.45))).toBe("genga");
  });

  it("the cold open NEVER routes douga — 'Begin.' emitted 0.2 live", () => {
    expect(classifyTier(intent(0.2), { opening: true })).toBe("genga");
    // The guard floors at genga; it never suppresses an earned sakuga.
    expect(classifyTier(intent(0.9), { opening: true })).toBe("sakuga");
  });

  it("climbing arc phases floor at genga — §3's escalation guard, realized at tier level", () => {
    // The old Pacer promoteEffort was unsatisfiable at runtime (C9 audit:
    // douga never consulted the Pacer; consulted tiers already run ≥ high).
    // The guard now fires BEFORE routing, where it can actually prevent a
    // quiet build-up beat from starving on a douga contract.
    expect(classifyTier(intent(0.2), { climbing: true })).toBe("genga");
    expect(classifyTier(intent(0.25), { climbing: true })).toBe("genga");
    // Outside climbing phases the routine class still routes douga.
    expect(classifyTier(intent(0.2), { climbing: false })).toBe("douga");
    // The floor never suppresses an earned sakuga.
    expect(classifyTier(intent(0.8), { climbing: true })).toBe("sakuga");
  });

  it("routed-work intents never douga regardless of epicness", () => {
    for (const kind of ["COMBAT", "SOCIAL", "ABILITY"] as const) {
      expect(classifyTier(intent(0.1, { intent: kind }))).not.toBe("douga");
    }
  });

  it("sakuga edges unchanged: combat, flags, and 0.7+ still route up", () => {
    expect(classifyTier(intent(0.7))).toBe("sakuga");
    expect(classifyTier(intent(0.2, { intent: "COMBAT" }))).toBe("sakuga");
    expect(classifyTier(intent(0.2, { special_conditions: ["power_reveal"] }))).toBe("sakuga");
  });

  it("the thresholds carry the calibrated values", () => {
    expect(TRIAGE_THRESHOLDS.dougaMaxEpicness).toBe(0.3);
    expect(TRIAGE_THRESHOLDS.sakugaMinEpicness).toBe(0.7);
  });
});
