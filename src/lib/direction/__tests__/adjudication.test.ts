import type { SeedVerdict } from "@/lib/types/direction";
import { describe, expect, it, vi } from "vitest";
import { clampAdjudication } from "../adjudication";

/**
 * The batched adjudication's bounds discipline (§7.6, C1 clamp pattern): the
 * strict-output grammar carries types and enums and STRIPS ranges, so every
 * limit on SeedVerdict is applied here. The rule under test is that the BATCH
 * always survives — a malformed verdict costs itself and nothing else.
 */

const verdict = (over: Partial<SeedVerdict>): SeedVerdict => ({
  seed_ref: 0,
  verdict: "mention",
  confidence: 0.9,
  evidence: "the debt is named aloud",
  ...over,
});

describe("clampAdjudication", () => {
  it("keeps in-range verdicts untouched", () => {
    const kept = clampAdjudication([verdict({ seed_ref: 0 }), verdict({ seed_ref: 2 })], 3);
    expect(kept.map((v) => v.seed_ref)).toEqual([0, 2]);
  });

  it("drops out-of-range refs and keeps the rest of the batch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampAdjudication(
      [verdict({ seed_ref: 7 }), verdict({ seed_ref: -1 }), verdict({ seed_ref: 1 })],
      3,
    );
    expect(kept.map((v) => v.seed_ref)).toEqual([1]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the FIRST verdict per seed — a second opinion never overwrites", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampAdjudication(
      [verdict({ seed_ref: 1, verdict: "payoff" }), verdict({ seed_ref: 1, verdict: "conflict" })],
      3,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.verdict).toBe("payoff");
    warn.mockRestore();
  });

  it("pins confidence into [0,1] rather than failing the parse", () => {
    const kept = clampAdjudication(
      [verdict({ seed_ref: 0, confidence: 1.4 }), verdict({ seed_ref: 1, confidence: -0.2 })],
      2,
    );
    expect(kept[0]?.confidence).toBe(1);
    expect(kept[1]?.confidence).toBe(0);
  });

  it("caps the batch at one verdict per rendered seed", () => {
    const kept = clampAdjudication(
      [verdict({ seed_ref: 0 }), verdict({ seed_ref: 1 }), verdict({ seed_ref: 2 })],
      2,
    );
    expect(kept).toHaveLength(2);
  });

  it("an empty emit is not an error", () => {
    expect(clampAdjudication([], 4)).toEqual([]);
  });
});
