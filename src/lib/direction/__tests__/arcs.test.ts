import { budgetPriorFor, expectedTension, payoffDebt } from "@/lib/direction/arcs";
import type { ArcRow } from "@/lib/direction/arcs";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import type { PremiseContract } from "@/lib/types/premise";
import { describe, expect, it } from "vitest";

/**
 * Pure-code coverage for the Arc Model (§7.3): the shape→tension curves at
 * their documented edges, the payoff-debt rush signal, and the genre budget
 * bands. No DB — the DB-denominated functions live in the integration suite.
 */

describe("expectedTension curves (§7.3)", () => {
  it("rising climbs 0.2→1.0 to the 0.8 climax, then tails toward 0.5", () => {
    expect(expectedTension("rising", 0)).toBeCloseTo(0.2);
    expect(expectedTension("rising", 0.4)).toBeCloseTo(0.6);
    expect(expectedTension("rising", 0.8)).toBeCloseTo(1.0);
    expect(expectedTension("rising", 1)).toBeCloseTo(0.5);
    // Monotone rise up to the climax.
    expect(expectedTension("rising", 0.2)).toBeLessThan(expectedTension("rising", 0.6));
  });

  it("falling declines linearly 0.8→0.2", () => {
    expect(expectedTension("falling", 0)).toBeCloseTo(0.8);
    expect(expectedTension("falling", 0.5)).toBeCloseTo(0.5);
    expect(expectedTension("falling", 1)).toBeCloseTo(0.2);
  });

  it("cyclical oscillates between 0.3 and 0.8 across two waves", () => {
    expect(expectedTension("cyclical", 0)).toBeCloseTo(0.55);
    expect(expectedTension("cyclical", 0.125)).toBeCloseTo(0.8); // first crest
    expect(expectedTension("cyclical", 0.375)).toBeCloseTo(0.3); // first trough
    expect(expectedTension("cyclical", 0.625)).toBeCloseTo(0.8); // second crest
  });

  it("plateau stays flat at 0.45 within a ±0.05 texture band", () => {
    expect(expectedTension("plateau", 0)).toBeCloseTo(0.45);
    for (const f of [0, 0.13, 0.27, 0.5, 0.75, 1]) {
      const t = expectedTension("plateau", f);
      expect(t).toBeGreaterThanOrEqual(0.4);
      expect(t).toBeLessThanOrEqual(0.5);
    }
  });

  it("fragmented spikes to 0.8 near 0.2-multiples over a slow rising throughline", () => {
    expect(expectedTension("fragmented", 0.4)).toBeCloseTo(0.8); // on a spike
    expect(expectedTension("fragmented", 0.6)).toBeCloseTo(0.8); // on a spike
    // Off-spike sits on the throughline (0.3 + 0.15·f), and rises with f.
    expect(expectedTension("fragmented", 0.1)).toBeCloseTo(0.315);
    expect(expectedTension("fragmented", 0.1)).toBeLessThan(expectedTension("fragmented", 0.5));
  });

  it("clamps to [0,1] across every shape and any fraction (incl. out-of-range)", () => {
    for (const shape of ["rising", "falling", "cyclical", "plateau", "fragmented", "???"]) {
      for (const f of [-0.5, 0, 0.33, 0.8, 1, 1.5]) {
        const t = expectedTension(shape, f);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    }
  });

  it("unknown shape returns the neutral mid-band", () => {
    expect(expectedTension("not-a-shape", 0.5)).toBeCloseTo(0.5);
  });
});

describe("payoffDebt (§7.3 rush signal)", () => {
  const arc = (contract: { status: string }[], tolerance: number): ArcRow =>
    ({
      payoffContract: contract,
      budget: { unit: "episodes", target: 4, tolerance },
    }) as unknown as ArcRow;

  it("counts open items and flags rushed when remaining ≤ tolerance", () => {
    const a = arc([{ status: "open" }, { status: "resolved" }], 2);
    const debt = payoffDebt(a, { consumed: 3, target: 4 });
    expect(debt.openItems).toBe(1);
    expect(debt.remaining).toBe(1);
    expect(debt.rushed).toBe(true);
  });

  it("is not rushed while budget remains beyond tolerance", () => {
    const a = arc([{ status: "open" }], 2);
    const debt = payoffDebt(a, { consumed: 1, target: 4 });
    expect(debt.remaining).toBe(3);
    expect(debt.rushed).toBe(false);
  });

  it("is never rushed with no open items, even at the wire", () => {
    const a = arc([{ status: "resolved" }, { status: "carried" }], 2);
    const debt = payoffDebt(a, { consumed: 4, target: 4 });
    expect(debt.openItems).toBe(0);
    expect(debt.rushed).toBe(false);
  });

  it("tolerates a non-array payoff contract", () => {
    const a = { payoffContract: null, budget: { target: 4, tolerance: 1 } } as unknown as ArcRow;
    expect(payoffDebt(a, { consumed: 4, target: 4 }).openItems).toBe(0);
  });
});

describe("budgetPriorFor bands (§7.3 genre priors)", () => {
  const withPacing = (pacing: number): PremiseContract => {
    const c = bebopContract();
    c.active.treatment.pacing = pacing;
    return c;
  };

  it("fast IP (pacing ≥ 7) → 2-episode arcs with tolerance 1", () => {
    for (const p of [7, 8, 10]) {
      expect(budgetPriorFor(withPacing(p))).toEqual({ unit: "episodes", target: 2, tolerance: 1 });
    }
  });

  it("mid-tempo (pacing 4–6) → 4-episode arcs with tolerance 2", () => {
    for (const p of [4, 5, 6]) {
      expect(budgetPriorFor(withPacing(p))).toEqual({ unit: "episodes", target: 4, tolerance: 2 });
    }
  });

  it("slow burn (pacing ≤ 3) → 6-episode arcs with tolerance 2", () => {
    for (const p of [0, 2, 3]) {
      expect(budgetPriorFor(withPacing(p))).toEqual({ unit: "episodes", target: 6, tolerance: 2 });
    }
  });

  it("Bebop's canonical pacing (6) lands in the moderate band", () => {
    expect(budgetPriorFor(bebopContract())).toEqual({ unit: "episodes", target: 4, tolerance: 2 });
  });
});
