import { describe, expect, it } from "vitest";
import {
  type SeedIntegrityInput,
  type SeedLedgerRow,
  analyzeSeedIntegrity,
  classifySeed,
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

function input(over: Partial<SeedIntegrityInput> = {}): SeedIntegrityInput {
  return {
    campaignId: "camp",
    lastTurn: 52,
    playedTurns: 50,
    sweptTurns: 50,
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

  it("a late payoff fails the window clause and names the overrun", () => {
    const run = healthy();
    run.seeds[0] = seed({ id: "a", status: "resolved", resolvedTurn: 34 });
    const out = analyzeSeedIntegrity(run);
    expect(verdictOf(out, "payoff-window")).toBe("fail");
    expect(out.probes[0]?.detail).toContain("4 turn(s) past");
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
