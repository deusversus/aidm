import { describe, expect, it } from "vitest";
import { type DriftGate, type DriftPoint, classifyAxisVerdict } from "../scripts/soak-lib";

/**
 * The drift-soak's third verdict class (§4.5 M2R3). Pure classifier — no DB, no
 * model. The M2 drift soak lacked the `player_driven` box: continuity ended the
 * run engaged (delta 5.2, 13 consecutive) but the PLAYER drove it, and the
 * harness read FAIL. With the gate-trip attribution, such an axis escalates.
 */

const GATE: DriftGate = { threshold: 2, confidence: 0.6, consecutive: 2 };
const p = (
  atTurn: number,
  delta: number,
  confidence: number,
  consecutiveDrift: number,
): DriftPoint => ({
  atTurn,
  delta,
  confidence,
  consecutiveDrift,
});

describe("classifyAxisVerdict (drift-soak gate parity)", () => {
  it("clean: an axis that never drifts", () => {
    expect(classifyAxisVerdict([p(8, 0.4, 0.9, 0)], GATE, false)).toBe("clean");
  });

  it("corrected: drifted out, then pulled back in band (the machinery WORKING)", () => {
    const seq = [p(8, 3, 0.9, 1), p(16, 0.4, 0.9, 0)];
    expect(classifyAxisVerdict(seq, GATE, false)).toBe("corrected");
    // The player-driven flag does not change a resolved sequence.
    expect(classifyAxisVerdict(seq, GATE, true)).toBe("corrected");
  });

  it("unresolved: final read drifting but below the consecutive trigger (never due)", () => {
    expect(classifyAxisVerdict([p(8, 3, 0.9, 1)], GATE, false)).toBe("unresolved");
  });

  it("uncorrected: engaged at run end and NOT player-driven — the FAIL", () => {
    const seq = [p(8, 3, 0.9, 2), p(16, 5, 0.9, 5)];
    expect(classifyAxisVerdict(seq, GATE, false)).toBe("uncorrected");
  });

  it("player_driven: the same engaged sequence, charged to the PLAYER — escalated, NOT a fail", () => {
    const seq = [p(8, 3, 0.9, 2), p(16, 5, 0.9, 5)];
    expect(classifyAxisVerdict(seq, GATE, true)).toBe("player_driven");
  });

  it("the M2 continuity scenario: delta 5.2, 13 consecutive, player-driven → escalated", () => {
    // The exact shape the M2 soak read as FAIL — now the third class.
    const seq = [p(3, 5.0, 0.9, 2), p(11, 5.1, 0.91, 6), p(24, 5.2, 0.92, 13)];
    expect(classifyAxisVerdict(seq, GATE, false)).toBe("uncorrected");
    expect(classifyAxisVerdict(seq, GATE, true)).toBe("player_driven");
  });

  it("a low-confidence engaged read is not drifting → not a fail", () => {
    // delta ≥ 2 but confidence below the gate: never counts as drift.
    expect(classifyAxisVerdict([p(8, 5, 0.4, 3)], GATE, false)).toBe("clean");
  });
});
