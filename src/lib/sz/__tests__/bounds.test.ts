import { describe, expect, it } from "vitest";
import { resolveObservations } from "../compiler";
import { Observation } from "../conductor";

/**
 * The M3 C2 numeric-bounds sweep on the Session Zero path — one site of each
 * class, so the RULE is pinned, not just the code.
 *
 * PROTECTIVE (kept): the compiler's calibration parse. Its failure path is a
 * visible gap note, and a clamped value would enter the DNA scales as a
 * number the player never chose (§8: the compiler never ships a silent guess).
 *
 * DESTROY (bounded out): the conductor's `Observation.confidence`. The tool's
 * own input schema never carried the bound, so it constrained nothing — it
 * only decided whether a stray 1.5 threw away the CONTENT, which is the spark
 * verbatim, the finitude answer, a hard line.
 */

describe("Observation.confidence — destroy-class, bounded out", () => {
  it("an out-of-band confidence still parses: the observation is never lost to it", () => {
    const high = Observation.safeParse({ kind: "spark", content: "the rain scene", confidence: 4 });
    expect(high.success).toBe(true);
    const low = Observation.safeParse({ kind: "hard_line", content: "no kids", confidence: -2 });
    expect(low.success).toBe(true);
  });

  it("content keeps its bound — an observation with nothing in it is nothing", () => {
    expect(Observation.safeParse({ kind: "spark", content: "" }).success).toBe(false);
    // The kind enum is grammar-native and stays enforced.
    expect(Observation.safeParse({ kind: "not_a_kind", content: "x" }).success).toBe(false);
  });

  it("confidence still defaults when the conductor omits it", () => {
    const parsed = Observation.parse({ kind: "spark", content: "the rain scene" });
    expect(parsed.confidence).toBeCloseTo(0.9);
  });
});

describe("calibration value — protective-class, bound kept", () => {
  it("an out-of-range calibration is DROPPED with a gap note, never clamped in", () => {
    // Bad record LAST: a later readable record of the same kind clears the
    // note (the compiler's order-aware rule), so the drop is only observable
    // when the impossible value is the most recent thing said.
    const resolved = resolveObservations([
      { kind: "calibration", content: JSON.stringify({ axis: "pacing", value: 7 }), confidence: 1 },
      {
        kind: "calibration",
        content: JSON.stringify({ axis: "darkness", value: 14 }),
        confidence: 1,
      },
    ]);
    // The good axis lands; the impossible one does not become a silent 10.
    expect(resolved.calibration.pacing).toBe(7);
    expect(resolved.calibration.darkness).toBeUndefined();
    // Surfaced as an OPEN item for the conductor, not swallowed (§8).
    expect(resolved.parseFailures.some((f) => f.includes("calibration"))).toBe(true);
  });

  it("an in-range calibration at both extremes lands untouched", () => {
    const resolved = resolveObservations([
      {
        kind: "calibration",
        content: JSON.stringify({ axis: "darkness", value: 0 }),
        confidence: 1,
      },
      {
        kind: "calibration",
        content: JSON.stringify({ axis: "comedy", value: 10 }),
        confidence: 1,
      },
    ]);
    expect(resolved.calibration.darkness).toBe(0);
    expect(resolved.calibration.comedy).toBe(10);
    expect(resolved.parseFailures).toEqual([]);
  });
});
