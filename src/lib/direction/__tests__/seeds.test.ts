import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import {
  ORGANIC_CANDIDATE_THRESHOLD,
  SEED_CONVERGENCE_MAX_PAIRS,
  SEED_CONVERGENCE_SIMILARITY,
  SEED_MAX_TURNS_TO_PAYOFF,
  parseCandidates,
} from "@/lib/types/direction";
import { describe, expect, it } from "vitest";
import { type SeedRow, adjustedWindow, convergenceCandidates, pendingCandidates } from "../seeds";

/**
 * The DB-less half of the §7.6 seed ledger (M3 C2): the push-out's window
 * math, the pure-code convergence detector, and the candidate accumulator's
 * tolerant read. The DB-denominated half lives in seeds.integration.test.ts.
 */

/** Unit vectors in a 1024-dim space; `tilt` rotates b away from a in one plane. */
function pair(tilt: number): [number[], number[]] {
  const a = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
  const b = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === 0 ? Math.cos(tilt) : i === 1 ? Math.sin(tilt) : 0,
  );
  return [a, b];
}

function seed(over: Partial<SeedRow> = {}): SeedRow {
  return {
    id: crypto.randomUUID(),
    campaignId: "c",
    description: "a seed",
    expectedPayoff: null,
    status: "planted",
    plantedTurn: 1,
    payoffWindow: null,
    urgency: 0.5,
    dependencies: [],
    mentionCount: 0,
    resolvedTurn: null,
    embedding: null,
    candidates: [],
    resolvedBy: null,
    turnId: 1,
    provenance: "director",
    confidence: 0.9,
    createdAt: new Date(),
    tombstonedAt: null,
    ...over,
  } as SeedRow;
}

describe("adjustedWindow (the adjust_window push-out, §7.6)", () => {
  const current = { from: 6, to: 20 };

  it("pushes `to` out and leaves `from` alone", () => {
    expect(adjustedWindow(current, 18, undefined, 40)).toEqual({ from: 6, to: 40 });
  });

  it("never lands the window on or before the current turn", () => {
    // A push-out that leaves the seed instantly overdue is the state the op
    // exists to clear — the story asked for MORE room, not less.
    expect(adjustedWindow(current, 30, undefined, 25)).toEqual({ from: 6, to: 31 });
    expect(adjustedWindow(current, 30, undefined, 30)).toEqual({ from: 6, to: 31 });
  });

  it("caps at the v3 horizon from the current turn", () => {
    const pushed = adjustedWindow(current, 10, undefined, 9_999);
    expect(pushed).toEqual({ from: 6, to: 10 + SEED_MAX_TURNS_TO_PAYOFF });
  });

  it("returns undefined when nothing was asked for, or nothing would change", () => {
    expect(adjustedWindow(current, 10)).toBeUndefined();
    expect(adjustedWindow(current, 10, 6, 20)).toBeUndefined();
  });

  it("moves `from` only when the caller names it, and keeps `to` at or past it", () => {
    expect(adjustedWindow(current, 5, 12, undefined)).toEqual({ from: 12, to: 20 });
    expect(adjustedWindow(current, 5, 30, 25)).toEqual({ from: 30, to: 30 });
  });
});

describe("parseCandidates / pendingCandidates", () => {
  it("reads well-formed entries and drops malformed ones without throwing", () => {
    const parsed = parseCandidates([
      { t: 3, s: 0.61 },
      { t: 4, s: 0.7, adj: true },
      { t: "nope", s: 0.9 },
      null,
      42,
    ]);
    expect(parsed).toEqual([
      { t: 3, s: 0.61 },
      { t: 4, s: 0.7, adj: true },
    ]);
  });

  it("a non-array column reads as no candidates", () => {
    expect(parseCandidates(null)).toEqual([]);
    expect(parseCandidates({ t: 1 })).toEqual([]);
  });

  it("pending excludes candidates a batch already read (the cost law)", () => {
    const row = seed({
      candidates: [
        { t: 3, s: 0.6, adj: true },
        { t: 5, s: 0.8 },
      ],
    });
    expect(pendingCandidates(row)).toEqual([{ t: 5, s: 0.8 }]);
  });
});

describe("convergenceCandidates (§7.6 — pure code, no model call)", () => {
  it("pairs seeds whose candidate turns overlap", () => {
    const a = seed({ description: "the mole in the crew", candidates: [{ t: 5, s: 0.6 }] });
    const b = seed({
      description: "an unpaid debt",
      candidates: [
        { t: 5, s: 0.58 },
        { t: 9, s: 0.6 },
      ],
    });
    const c = seed({ description: "an old photograph", candidates: [{ t: 12, s: 0.6 }] });

    const found = convergenceCandidates([a, b, c]);
    expect(found).toHaveLength(1);
    expect(found[0]?.sharedTurns).toEqual([5]);
    expect([found[0]?.a.id, found[0]?.b.id].sort()).toEqual([a.id, b.id].sort());
  });

  it("pairs seeds whose descriptions are mutually similar, with no shared scene", () => {
    // ~0.94 cosine — above SEED_CONVERGENCE_SIMILARITY, no overlapping turns.
    const [va, vb] = pair(0.35);
    const found = convergenceCandidates([seed({ embedding: va }), seed({ embedding: vb })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.sharedTurns).toEqual([]);
    expect(found[0]?.similarity ?? 0).toBeGreaterThanOrEqual(SEED_CONVERGENCE_SIMILARITY);
  });

  it("ignores pairs below BOTH tests", () => {
    // ~0.54 cosine — above the candidate threshold's neighbourhood but well
    // below convergence, and no shared scenes.
    const [va, vb] = pair(1.0);
    const found = convergenceCandidates([seed({ embedding: va }), seed({ embedding: vb })]);
    expect(found).toEqual([]);
    // Guard the fixture: a drift in the constants must not silently make this
    // test assert nothing.
    expect(SEED_CONVERGENCE_SIMILARITY).toBeGreaterThan(ORGANIC_CANDIDATE_THRESHOLD);
  });

  it("only considers OPEN seeds — a resolved thread cannot converge with anything", () => {
    const a = seed({ status: "resolved", candidates: [{ t: 5, s: 0.6 }] });
    const b = seed({ status: "abandoned", candidates: [{ t: 5, s: 0.6 }] });
    const c = seed({ status: "confirmed", candidates: [{ t: 5, s: 0.6 }] });
    expect(convergenceCandidates([a, b, c])).toEqual([]);
  });

  it("orders by overlap then similarity, and caps the pairs it surfaces", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      seed({ description: `seed ${i}`, candidates: [{ t: 7, s: 0.6 }] }),
    );
    const strong = seed({
      description: "braided hard",
      candidates: [
        { t: 7, s: 0.6 },
        { t: 8, s: 0.6 },
        { t: 9, s: 0.6 },
      ],
    });
    const alsoStrong = seed({
      description: "braided hard too",
      candidates: [
        { t: 7, s: 0.6 },
        { t: 8, s: 0.6 },
        { t: 9, s: 0.6 },
      ],
    });
    const found = convergenceCandidates([...rows, strong, alsoStrong]);
    expect(found).toHaveLength(SEED_CONVERGENCE_MAX_PAIRS);
    expect(found[0]?.sharedTurns).toEqual([7, 8, 9]);
  });
});
