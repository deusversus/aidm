import { describe, expect, it } from "vitest";
import {
  type CallRow,
  type TurnRecord,
  buildSoakPlan,
  coldOpensFor,
  droppedOps,
  estimateRunPrice,
  meteringCoverage,
  partitionAttempts,
} from "../scripts/soak-lib";
import { COMPACTION_KEEP_TAIL, COMPACTION_TRIGGER_EXCHANGES } from "../src/lib/blocks/compaction";
import { DEV_TIER_SELECTION } from "../src/lib/llm/tiers";

/**
 * The M2 drift-soak harness holes, as tests (docs/retros/M2-drift-soak.md):
 * per-attempt metering, coverage that can SAY a turn was never asserted, and
 * the 100-turn plan/price wiring. Pure — no DB, no model.
 */

const t0 = new Date("2026-08-01T00:00:00Z");
const at = (secs: number): Date => new Date(t0.getTime() + secs * 1_000);

function call(createdAt: Date, costUsd: string): CallRow {
  return {
    id: `call-${createdAt.toISOString()}`,
    campaignId: "c",
    turnNumber: 9,
    provider: "anthropic",
    model: "claude-sonnet-5",
    tier: "narration",
    phase: "turn",
    inputTokens: 100,
    outputTokens: 100,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd,
    latencyMs: 1_000,
    fallbackUsed: false,
    traceId: null,
    createdAt,
  } as CallRow;
}

function record(turnNumber: number, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    step: turnNumber,
    turnNumber,
    label: "persona",
    tier: "genga",
    status: "complete",
    servedModel: "claude-sonnet-5",
    narrationUsd: 0.1,
    turnUsd: 0.13,
    cacheReadFrac: 0.9,
    ttftMs: 1_000,
    totalMs: 20_000,
    fallbackUsed: false,
    retried: false,
    narrationUsage: null,
    attempts: [{ index: 1, usd: 0.1, calls: 1 }],
    ledgerNarrationMissing: false,
    flags: [],
    failures: [],
    ...over,
  };
}

describe("partitionAttempts (M2: meter per-attempt, assert per-attempt)", () => {
  it("a single-attempt turn is one bucket, research rounds included", () => {
    const rows = [call(at(1), "0.10"), call(at(20), "0.05")];
    const buckets = partitionAttempts(rows, [at(0)]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toHaveLength(2);
  });

  it("the M2 turn-9 shape: three attempts split instead of summing to a false breach", () => {
    // Two truncated attempts then a completing one — $1.10 total against a
    // $0.53 single-attempt ceiling, which the M2 harness read as a cost breach.
    const rows = [call(at(1), "0.40"), call(at(100), "0.40"), call(at(200), "0.30")];
    const buckets = partitionAttempts(rows, [at(0), at(90), at(190)]);
    expect(buckets.map((b) => b.length)).toEqual([1, 1, 1]);
    const perAttempt = buckets.map((b) => b.reduce((s, r) => s + Number(r.costUsd), 0));
    expect(perAttempt).toEqual([0.4, 0.4, 0.3]);
    // Each attempt is under a ceiling the SUM ($1.10) would have breached.
    expect(Math.max(...perAttempt)).toBeLessThan(0.531);
  });

  it("attempts that produced no ledger row drop out (the executor died first)", () => {
    const buckets = partitionAttempts([call(at(200), "0.30")], [at(0), at(90), at(190)]);
    expect(buckets).toHaveLength(1);
  });
});

describe("meteringCoverage (M2: turns 9 and 24 were never asserted)", () => {
  it("certifies a run where every played turn carries an assertion", () => {
    const coverage = meteringCoverage([record(1), record(2), record(3)], 3);
    expect(coverage.certified).toBe(true);
    expect(coverage.missing).toEqual([]);
  });

  it("names the turns the driving loop never metered", () => {
    const coverage = meteringCoverage([record(1), record(3)], 3);
    expect(coverage.certified).toBe(false);
    expect(coverage.missing).toEqual([2]);
    expect(coverage.lines.join(" ")).toContain("UNMETERED");
  });

  it("names the metered-but-unasserted turn whose ledger row was lost", () => {
    const coverage = meteringCoverage(
      [record(1), record(2, { ledgerNarrationMissing: true, narrationUsd: 0 })],
      2,
    );
    expect(coverage.certified).toBe(false);
    expect(coverage.unasserted).toEqual([2]);
  });

  it("a resumed invocation only claims the turns it played", () => {
    const coverage = meteringCoverage([record(25)], 25, 25);
    expect(coverage.certified).toBe(true);
  });
});

describe("buildSoakPlan (the 100-turn mode)", () => {
  it("reproduces the M1 plan at the default N", () => {
    const plan = buildSoakPlan(30, 8, 2);
    expect(plan).toMatchObject({ turns: 30, pinAfter: 8, midpointAfter: 15, rewindAfter: 20 });
  });

  it("scales the structural ops to N without moving the specials", () => {
    const plan = buildSoakPlan(100, 8, 2);
    expect(plan.pinAfter).toBe(8);
    expect(plan.midpointAfter).toBe(50);
    expect(plan.rewindAfter).toBe(66);
    expect(plan.maxSteps).toBeGreaterThan(100);
  });

  it("keeps the rewind inside the §6.7 retake horizon wherever it fires", () => {
    expect(() => buildSoakPlan(100, 8, 11)).toThrow(/retake horizon/);
    expect(buildSoakPlan(100, 8, 10).rewindDepth).toBe(10);
  });

  it("lands the rewind's RE-CLIMB at or past the midpoint close, at every N", () => {
    // The weak form of this (rewindAfter > midpointAfter) passed at N=10 while
    // the rewind of 2 fired after turn 6 and landed at turn 4 — before the
    // midpoint boundary at 5 the run had already crossed. The landing turn is
    // the invariant, not the firing turn.
    for (const n of [2, 3, 5, 9, 10, 17, 30, 51, 100]) {
      for (const depth of [1, 2, 5, 10]) {
        const plan = buildSoakPlan(n, 8, depth);
        expect(plan.rewindAfter).toBeGreaterThan(plan.midpointAfter);
        expect(plan.rewindAfter - plan.rewindDepth).toBeGreaterThanOrEqual(plan.midpointAfter);
      }
    }
  });

  it("at N=10 the rewind clears the midpoint instead of re-climbing across it", () => {
    const plan = buildSoakPlan(10, 8, 2);
    expect(plan.midpointAfter).toBe(5);
    expect(plan.rewindAfter).toBe(7);
    expect(plan.rewindAfter - plan.rewindDepth).toBe(5);
  });

  it("names the ops a small N drops instead of leaving them a silent checklist miss", () => {
    const short = droppedOps(buildSoakPlan(2, 8, 2));
    expect(short.join(" ")).toContain("pin");
    expect(short.join(" ")).toContain("rewind");
    expect(droppedOps(buildSoakPlan(1, 8, 2)).join(" ")).toContain("no midpoint turn");
    // The full-size plans drop nothing.
    expect(droppedOps(buildSoakPlan(30, 8, 2))).toEqual([]);
    expect(droppedOps(buildSoakPlan(100, 8, 2))).toEqual([]);
  });

  it("rejects a nonsense N", () => {
    expect(() => buildSoakPlan(0, 8, 2)).toThrow();
    expect(() => buildSoakPlan(1.5, 8, 2)).toThrow();
  });
});

describe("estimateRunPrice (the pre-run banner)", () => {
  it("counts cold opens as sittings plus compaction resets", () => {
    expect(coldOpensFor(10, 2)).toEqual({ total: 2, compactions: 0 });
    expect(coldOpensFor(100, 2).compactions).toBe(9);
  });

  it("walks the real compaction cadence: first at 21, then every 9", () => {
    // RE-BASELINED for the 32k window ruling (user, 2026-08-05): the exchange
    // trigger scaled 16 → 20 and the keep-tail 10 → 12 alongside it, so
    // shouldCompact fires on length > 20 (at 21 exchanges) and advances the
    // watermark by 9 — resets at 21, 30, 39 … 93. Fewer, larger events: 9 at
    // N=100 where the old 16/10 pair gave 12, which is the cache economics
    // moving the right way even as the window doubled.
    expect(coldOpensFor(20, 1).compactions).toBe(0);
    expect(coldOpensFor(21, 1).compactions).toBe(1);
    expect(coldOpensFor(29, 1).compactions).toBe(1);
    expect(coldOpensFor(30, 1).compactions).toBe(2);
    expect(coldOpensFor(39, 1).compactions).toBe(3);
    expect(coldOpensFor(92, 1).compactions).toBe(8);
    expect(coldOpensFor(93, 1).compactions).toBe(9);
    expect(coldOpensFor(100, 1).compactions).toBe(9);
    expect(coldOpensFor(100, 2).total).toBe(11);
  });

  it("agrees with a simulation of the window (the token trigger stays unmodeled)", () => {
    // The exchange-count trigger, simulated turn by turn from the same
    // constants the engine uses. The TOKEN trigger can only fire an event
    // EARLIER, so the modeled count is a floor — deliberately conservative.
    const simulate = (turns: number): number => {
      let watermark = 0;
      let events = 0;
      for (let n = 1; n <= turns; n++) {
        const window = n - watermark;
        if (window > COMPACTION_TRIGGER_EXCHANGES) {
          events += 1;
          watermark += window - COMPACTION_KEEP_TAIL;
        }
      }
      return events;
    };
    for (const n of [1, 16, 17, 24, 30, 50, 94, 100, 250]) {
      expect(coldOpensFor(n, 1).compactions).toBe(simulate(n));
    }
  });

  it("prices 100 turns with the floor below the expected below the ceiling", () => {
    const e = estimateRunPrice(100, DEV_TIER_SELECTION, 2);
    expect(e.warmFloorUsd).toBeLessThan(e.expectedUsd);
    expect(e.expectedUsd).toBeLessThan(e.coldCeilingUsd);
    expect(e.warmTurns + e.coldTurns).toBe(100);
    expect(e.narrationModel).toBe(DEV_TIER_SELECTION.narration);
  });

  it("scales with N and always states the spend gate", () => {
    const thirty = estimateRunPrice(30, DEV_TIER_SELECTION, 2);
    const hundred = estimateRunPrice(100, DEV_TIER_SELECTION, 2);
    expect(hundred.expectedUsd).toBeGreaterThan(thirty.expectedUsd * 2);
    expect(hundred.lines.join("\n")).toContain("SPEND IS GATED BY THE USER");
  });
});
