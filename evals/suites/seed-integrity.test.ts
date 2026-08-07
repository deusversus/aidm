import { DIRECTOR_MAX_INTERVAL } from "@/lib/types/direction";
import { describe, expect, it } from "vitest";
import {
  type SeedIntegrityInput,
  type SeedLedgerRow,
  analyzeSeedIntegrity,
  classifySeed,
  deriveCycleTolerance,
  windowOf,
} from "./seed-integrity";

/**
 * §10.5's adjudication, pure. The fixtures are shaped like a soaked campaign's
 * seed rows, so every clause of the blueprint's sentence — payoffs inside
 * windows, no orphaned dependencies, organic recall against the declared-only
 * baseline — is provable without a soak and without a model call (the suite
 * makes none by design).
 */

function seed(over: Partial<SeedLedgerRow> = {}): SeedLedgerRow {
  return {
    id: "s1",
    description: "the fixer's missing brother is aboard the trawler",
    expectedPayoff: "the brother surfaces as the mark",
    status: "planted",
    plantedTurn: 10,
    payoffWindow: { from: 15, to: 30 },
    resolvedTurn: null,
    resolvedBy: null,
    mentionCount: 0,
    candidates: [],
    dependencies: [],
    provenance: "director",
    tombstoned: false,
    ...over,
  };
}

/**
 * A run's Director-cycle turns, shaped like the N=50 soak's: DIRECTOR_MIN_
 * TURNS_BETWEEN (3) plus event triggers, never the DIRECTOR_MAX_INTERVAL
 * backstop. Widest gap 4, so the settlement tolerance this run earns is 3 —
 * not the constant's 7.
 */
const CYCLE_TURNS = [0, 3, 6, 10, 13, 17, 20, 24, 27, 31, 35, 38, 42, 46, 50];

function input(over: Partial<SeedIntegrityInput> = {}): SeedIntegrityInput {
  return {
    campaignId: "camp",
    lastTurn: 52,
    playedTurns: 50,
    sweptTurns: 50,
    cycleTurns: CYCLE_TURNS,
    seeds: [],
    declared: [],
    ...over,
  };
}

const verdictOf = (result: ReturnType<typeof analyzeSeedIntegrity>, name: string) =>
  result.probes.find((p) => p.name.startsWith(name))?.verdict;

describe("windowOf (mirrors direction/seeds.ts)", () => {
  it("reads the stored window", () => {
    expect(windowOf(seed({ payoffWindow: { from: 4, to: 9 } }))).toEqual({ from: 4, to: 9 });
  });

  it("defaults off the plant turn when the window was never stored", () => {
    // SEED_MIN_TURNS_TO_PAYOFF 5 / SEED_MAX_TURNS_TO_PAYOFF 50 (v3, verbatim).
    expect(windowOf(seed({ payoffWindow: null, plantedTurn: 10 }))).toEqual({ from: 15, to: 60 });
  });

  it("survives a malformed jsonb window rather than throwing the ledger away", () => {
    expect(windowOf(seed({ payoffWindow: { from: "soon" }, plantedTurn: 3 }))).toEqual({
      from: 8,
      to: 53,
    });
  });
});

describe("classifySeed", () => {
  const at = 52;
  it("pays inside the window", () => {
    expect(classifySeed(seed({ status: "resolved", resolvedTurn: 20 }), at)).toBe("paid_in_window");
  });
  it("pays EARLY — before the window opened", () => {
    expect(classifySeed(seed({ status: "resolved", resolvedTurn: 12 }), at)).toBe("paid_early");
  });
  it("pays LATE — past the window's close", () => {
    expect(classifySeed(seed({ status: "resolved", resolvedTurn: 31 }), at)).toBe("paid_late");
  });
  it("open inside the window is not a miss", () => {
    expect(classifySeed(seed({ payoffWindow: { from: 15, to: 60 } }), at)).toBe("open_in_window");
  });
  it("open past the window is the miss", () => {
    expect(classifySeed(seed(), at)).toBe("expired_unpaid");
  });
  it("abandoned is a deliberate end, never a window miss", () => {
    expect(classifySeed(seed({ status: "abandoned", resolvedBy: "director" }), at)).toBe(
      "abandoned",
    );
  });
});

describe("analyzeSeedIntegrity — §10.5's three clauses", () => {
  const healthy = () =>
    input({
      seeds: [
        seed({ id: "a", status: "resolved", resolvedTurn: 20, resolvedBy: "adjudicator_payoff" }),
        seed({ id: "b", payoffWindow: { from: 40, to: 60 }, plantedTurn: 35 }),
        seed({ id: "c", status: "abandoned", resolvedBy: "adjudicator_conflict" }),
        seed({
          id: "d",
          payoffWindow: { from: 20, to: 60 },
          mentionCount: 1,
          candidates: [{ t: 22, s: 0.61, adj: true }],
        }),
      ],
      declared: [{ turn: 18, seedId: "d" }],
    });

  it("a disciplined ledger passes every probe", () => {
    const out = analyzeSeedIntegrity(healthy());
    expect(out.probes.every((p) => p.verdict === "pass")).toBe(true);
  });

  /**
   * The cycle tolerance (M3R4 R-2, re-derived by the R-2 audit). A payoff is
   * SETTLED by the §7.6 batched adjudicator, which only runs on Director-cycle
   * turns — so a payoff landing on the page the turn after a window shuts
   * cannot be RECORDED until the next cycle fires. Lateness inside that gap is
   * the cadence, not the ledger rotting; lateness beyond it is still a miss.
   *
   * The bound comes from the RUN, not from DIRECTOR_MAX_INTERVAL: that constant
   * is the nothing-happened backstop (8), while the real spacing is
   * DIRECTOR_MIN_TURNS_BETWEEN plus event triggers, measured at 4 on the soak.
   * Grading against the constant would have granted a 7-turn amnesty no run
   * ever earned.
   */
  const window30 = { from: 15, to: 30 };
  const tolerance = deriveCycleTolerance(CYCLE_TURNS).tolerance;

  it("derives the tolerance from the run's widest observed cycle gap, minus one", () => {
    expect(tolerance).toBe(3);
    expect(tolerance).toBeLessThan(DIRECTOR_MAX_INTERVAL - 1);
    expect(deriveCycleTolerance(CYCLE_TURNS).source).toContain("widest gap 4");
  });

  it("a payoff late by the cycle tolerance PASSES — that lateness is structure", () => {
    const run = healthy();
    run.seeds[0] = seed({
      id: "a",
      status: "resolved",
      payoffWindow: window30,
      resolvedTurn: window30.to + tolerance,
    });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "payoff-window")).toBe("pass");
    expect(out.probes[0]?.detail).toContain(`1 late within the ${tolerance}-turn cycle tolerance`);
    // The reader is told what was graded and WHERE THE NUMBER CAME FROM, not
    // just the grade.
    expect(out.probes[0]?.detail).toContain("this run's OWN cadence");
    expect(out.probes[0]?.detail).toContain("widest gap 4");
  });

  it("one turn past the tolerance FAILS the window clause and names the overrun", () => {
    const run = healthy();
    run.seeds[0] = seed({
      id: "a",
      status: "resolved",
      payoffWindow: window30,
      resolvedTurn: window30.to + tolerance + 1,
    });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "payoff-window")).toBe("fail");
    expect(out.probes[0]?.detail).toContain(`${tolerance + 1} turn(s) past`);
    expect(out.probes[0]?.detail).toContain("1 late BEYOND it");
  });

  /**
   * The fallback, pinned. A run with no recoverable cycle history cannot have
   * its cadence measured, so the backstop constant stands in — and the output
   * SAYS it is standing in, because a tolerance nobody observed must never read
   * like one that was.
   */
  it("falls back to DIRECTOR_MAX_INTERVAL−1 when the run has no cycle history, and names it", () => {
    expect(deriveCycleTolerance([]).tolerance).toBe(DIRECTOR_MAX_INTERVAL - 1);
    expect(deriveCycleTolerance([12]).tolerance).toBe(DIRECTOR_MAX_INTERVAL - 1);
    expect(deriveCycleTolerance([12]).source).toContain("FALLBACK DIRECTOR_MAX_INTERVAL−1");

    const run = healthy();
    run.cycleTurns = [];
    run.seeds[0] = seed({
      id: "a",
      status: "resolved",
      payoffWindow: window30,
      resolvedTurn: window30.to + DIRECTOR_MAX_INTERVAL - 1,
    });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "payoff-window")).toBe("pass");
    expect(out.probes[0]?.detail).toContain("FALLBACK DIRECTOR_MAX_INTERVAL−1");
    // …and the fallback is not a wider amnesty in disguise: one past it fails.
    run.seeds[0] = seed({
      id: "a",
      status: "resolved",
      payoffWindow: window30,
      resolvedTurn: window30.to + DIRECTOR_MAX_INTERVAL,
    });
    expect(verdictOf(analyzeSeedIntegrity(run), "payoff-window")).toBe("fail");
  });

  it("the run's own cadence is STRICTER than the constant — the 4-late artifact still fails", () => {
    // Late by 4: inside DIRECTOR_MAX_INTERVAL−1's amnesty, outside this run's.
    const run = healthy();
    run.seeds[0] = seed({
      id: "a",
      status: "resolved",
      payoffWindow: window30,
      resolvedTurn: window30.to + 4,
    });
    expect(verdictOf(analyzeSeedIntegrity(run), "payoff-window")).toBe("fail");
  });

  it("the tolerance never launders an EXPIRED seed — that probe is untouched", () => {
    // The 13-rotted finding stands: an unpaid seed the run outlived is a miss
    // no matter how the cadence lands.
    const run = healthy();
    run.seeds[1] = seed({ id: "b", payoffWindow: { from: 15, to: 51 } }); // lastTurn 52
    expect(verdictOf(analyzeSeedIntegrity(run), "no expired-unpaid")).toBe("fail");
  });

  it("an early payoff fails too — the window is a contract in both directions", () => {
    const run = healthy();
    run.seeds[0] = seed({ id: "a", status: "resolved", resolvedTurn: 11 });
    expect(verdictOf(analyzeSeedIntegrity(run), "payoff-window")).toBe("fail");
  });

  it("no settled seed at all is UNPROVEN, never a pass", () => {
    const out = analyzeSeedIntegrity(
      input({ seeds: [seed({ payoffWindow: { from: 40, to: 60 } })], declared: [] }),
    );
    expect(verdictOf(out, "payoff-window")).toBe("unproven");
  });

  it("a seed the run outlived fails the expiry probe", () => {
    const run = healthy();
    run.seeds[1] = seed({ id: "b", payoffWindow: { from: 15, to: 30 } });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "no expired-unpaid")).toBe("fail");
    expect(out.probes[1]?.detail).toContain("22 turn(s) overdue");
  });

  it("a dangling dependency id is an orphan", () => {
    const run = healthy();
    run.seeds[1] = seed({
      id: "b",
      payoffWindow: { from: 40, to: 60 },
      dependencies: ["ffffffff-dead-4000-8000-000000000000"],
    });
    expect(verdictOf(analyzeSeedIntegrity(run), "no orphaned")).toBe("fail");
  });

  it("a dependency on an ABANDONED seed is an orphan — that gate never opens", () => {
    const run = healthy();
    run.seeds[1] = seed({ id: "b", payoffWindow: { from: 40, to: 60 }, dependencies: ["c"] });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "no orphaned")).toBe("fail");
    expect(out.probes[2]?.detail).toContain("ABANDONED");
  });

  it("a dependency on a TOMBSTONED seed is an orphan, not a dangling id", () => {
    const run = healthy();
    run.seeds.push(seed({ id: "z", tombstoned: true }));
    run.seeds[1] = seed({ id: "b", payoffWindow: { from: 40, to: 60 }, dependencies: ["z"] });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "no orphaned")).toBe("fail");
    expect(out.probes[2]?.detail).toContain("TOMBSTONED");
  });

  it("a self-dependency and a cycle are both orphans", () => {
    const selfDep = healthy();
    selfDep.seeds[1] = seed({ id: "b", payoffWindow: { from: 40, to: 60 }, dependencies: ["b"] });
    expect(verdictOf(analyzeSeedIntegrity(selfDep), "no orphaned")).toBe("fail");

    const cycle = healthy();
    cycle.seeds[1] = seed({ id: "b", payoffWindow: { from: 40, to: 60 }, dependencies: ["d"] });
    cycle.seeds[3] = seed({ id: "d", dependencies: ["b"], payoffWindow: { from: 40, to: 60 } });
    const out = analyzeSeedIntegrity(cycle);
    expect(verdictOf(out, "no orphaned")).toBe("fail");
    expect(out.probes[2]?.detail).toContain("CYCLE");
  });

  it("a live-but-unresolved dependency is REPORTED, never failed", () => {
    const run = healthy();
    run.seeds[1] = seed({
      id: "b",
      payoffWindow: { from: 40, to: 60 },
      dependencies: ["d"], // 'd' is open, in window — a legal gate, still shut
    });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "no orphaned")).toBe("pass");
    expect(out.details.some((d) => d.includes("gated by an unresolved dependency"))).toBe(true);
  });

  it("organic recall grades SEED-level coverage of the declared-confirmed set", () => {
    const run = healthy();
    // Two declared-confirmed threads; the sweep independently found only one.
    run.seeds[1] = seed({ id: "b", payoffWindow: { from: 40, to: 60 }, mentionCount: 1 });
    run.declared = [
      { turn: 18, seedId: "d" },
      { turn: 21, seedId: "b" },
    ];
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "organic-detection recall")).toBe("pass");
    expect(out.probes[3]?.detail).toContain("recall 1/2 (50%)");
  });

  it("a detector blind to every confirmed thread FAILS", () => {
    const run = healthy();
    run.seeds[3] = seed({ id: "d", candidates: [], mentionCount: 1 });
    expect(verdictOf(analyzeSeedIntegrity(run), "organic-detection recall")).toBe("fail");
  });

  it("no declared mention at all is UNPROVEN — the baseline has no denominator", () => {
    const run = healthy();
    run.declared = [];
    expect(verdictOf(analyzeSeedIntegrity(run), "organic-detection recall")).toBe("unproven");
  });

  it("a run whose sweep never fired is UNPROVEN, not a pass", () => {
    const run = healthy();
    run.sweptTurns = 0;
    expect(verdictOf(analyzeSeedIntegrity(run), "organic-detection recall")).toBe("unproven");
  });

  it("candidates on scenes the declared path never named are counted as reach", () => {
    const run = healthy();
    run.seeds[3] = seed({
      id: "d",
      mentionCount: 1,
      candidates: [
        { t: 18, s: 0.6 }, // the declared turn — not reach
        { t: 30, s: 0.62 },
        { t: 31, s: 0.58 },
      ],
    });
    const out = analyzeSeedIntegrity(run);
    expect(out.probes[3]?.detail).toContain("2 on scenes the declared path never named");
  });

  it("an empty ledger is UNPROVEN on the ledger clauses, never green", () => {
    const out = analyzeSeedIntegrity(input());
    expect(verdictOf(out, "payoff-window")).toBe("unproven");
    expect(verdictOf(out, "no expired-unpaid")).toBe("unproven");
  });

  it("tombstoned seeds are out of the ledger's grades (rewind, §6.7)", () => {
    const out = analyzeSeedIntegrity(
      input({
        seeds: [
          seed({ id: "a", status: "resolved", resolvedTurn: 20 }),
          seed({ id: "ghost", tombstoned: true, payoffWindow: { from: 1, to: 2 } }),
        ],
        declared: [],
      }),
    );
    expect(verdictOf(out, "no expired-unpaid")).toBe("pass");
    expect(out.details[0]).toContain("1 tombstoned");
  });
});
