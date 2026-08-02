import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import type { IntentOutput } from "@/lib/types/turn";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The M3 C2 numeric-bounds sweep on the turn path. Both sites here are
 * DESTROY-class: the strict-output grammar strips `minimum`/`maximum`, so the
 * bound never constrained the model — it only decided whether a violation cost
 * the whole call. The scale judge is the hard core (the M1 soak already lost a
 * combat call to the sibling enum bound), and the relevance filter's "graceful"
 * catch degrades the turn to unranked memory. Model proposes, code disposes.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});
import { callJudgment } from "@/lib/llm/calls";
import type { MemoryCandidate } from "../retrieval";
import { FILTER_CAP, RANK_FLOOR, relevanceFilter } from "../retrieval";
import { judgeScale } from "../scale";

const mockJudgment = vi.mocked(callJudgment);

const intent = {
  intent: "COMBAT",
  epicness: 0.5,
  special_conditions: [],
  contains_world_assertion: false,
  confidence: 0.9,
} as unknown as IntentOutput;

const candidate = (i: number): MemoryCandidate =>
  ({
    id: `m${i}`,
    content: `memory ${i}`,
    category: "event",
    score: 0,
    layer: "semantic",
  }) as MemoryCandidate;

beforeEach(() => {
  mockJudgment.mockReset();
});

describe("judgeScale numeric bounds", () => {
  const args = {
    intent,
    playerInput: "I swing",
    characterTier: 5,
    worldBaselineTier: 8,
    memories: [],
    campaignId: "c1",
    turnNumber: 4,
  };

  it("an out-of-band threat_tier and multiplier PARSE and clamp — the combat call survives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockJudgment.mockResolvedValueOnce({
      context_modifiers: [{ kind: "environmental", multiplier: 4, reason: "storm" }],
      primary_scale: "tactical",
      threat_tier: 99,
      rationale: "why",
    } as never);
    const result = await judgeScale(DEV_TIER_SELECTION, args);
    // multiplier pinned to 1 (no suppression), tier pinned to T11 (weakest).
    expect(result.contextModifiers[0]?.multiplier).toBe(1);
    expect(result.effectiveRatio).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a negative threat_tier clamps to T0 rather than inverting the imbalance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockJudgment.mockResolvedValueOnce({
      context_modifiers: [],
      primary_scale: "tactical",
      threat_tier: -40,
      rationale: "why",
    } as never);
    const clamped = await judgeScale(DEV_TIER_SELECTION, args);

    mockJudgment.mockResolvedValueOnce({
      context_modifiers: [],
      primary_scale: "tactical",
      threat_tier: 0,
      rationale: "why",
    } as never);
    const atZero = await judgeScale(DEV_TIER_SELECTION, args);
    expect(clamped.effectiveRatio).toBeCloseTo(atZero.effectiveRatio);
    warn.mockRestore();
  });

  it("the schema itself no longer rejects an out-of-band emit (M3 C2)", async () => {
    mockJudgment.mockResolvedValueOnce({
      context_modifiers: [],
      primary_scale: "tactical",
      threat_tier: 3,
      rationale: "why",
    } as never);
    await judgeScale(DEV_TIER_SELECTION, args);
    const schema = mockJudgment.mock.calls[0]?.[1]?.schema;
    expect(
      schema?.safeParse({
        context_modifiers: [{ kind: "environmental", multiplier: 9, reason: "r" }],
        primary_scale: "tactical",
        threat_tier: 99,
        rationale: "why",
      }).success,
    ).toBe(true);
    // `.int()` is grammar-native and stays enforced.
    expect(
      schema?.safeParse({
        context_modifiers: [],
        primary_scale: "tactical",
        threat_tier: 3.5,
        rationale: "why",
      }).success,
    ).toBe(false);
  });
});

describe("relevanceFilter numeric bounds", () => {
  const candidates = [0, 1, 2, 3, 4, 5].map(candidate);

  it("an out-of-range score clamps and the rank SURVIVES (no pass-through degrade)", async () => {
    mockJudgment.mockResolvedValueOnce({
      scores: [
        { index: 0, score: 4.2 },
        { index: 1, score: -1 },
        { index: 2, score: 0.9 },
      ],
    } as never);
    const ranked = await relevanceFilter(
      DEV_TIER_SELECTION,
      candidates,
      intent,
      "I look around",
      undefined,
      { campaignId: "c1", turnNumber: 3 },
    );
    // Only the two above RANK_FLOOR survive — the -1 is pinned to 0 and drops,
    // and the ranking actually happened (a degrade would return all six).
    expect(ranked.map((c) => c.id)).toEqual(["m0", "m2"]);
    expect(ranked.length).toBeLessThan(candidates.length);
    expect(RANK_FLOOR).toBeGreaterThan(0);
  });

  it("an out-of-range index is simply unmatched, never a thrown rank", async () => {
    mockJudgment.mockResolvedValueOnce({
      scores: [
        { index: -5, score: 0.9 },
        { index: 99, score: 0.9 },
        { index: 3, score: 0.8 },
      ],
    } as never);
    const ranked = await relevanceFilter(
      DEV_TIER_SELECTION,
      candidates,
      intent,
      "I look around",
      undefined,
      { campaignId: "c1", turnNumber: 3 },
    );
    expect(ranked.map((c) => c.id)).toEqual(["m3"]);
    expect(ranked.length).toBeLessThanOrEqual(FILTER_CAP);
  });

  it("the schema no longer rejects an out-of-band emit (M3 C2)", async () => {
    mockJudgment.mockResolvedValueOnce({ scores: [] } as never);
    await relevanceFilter(DEV_TIER_SELECTION, candidates, intent, "x", undefined, {
      campaignId: "c1",
      turnNumber: 3,
    });
    const schema = mockJudgment.mock.calls[0]?.[1]?.schema;
    expect(schema?.safeParse({ scores: [{ index: -1, score: 7 }] }).success).toBe(true);
  });
});
