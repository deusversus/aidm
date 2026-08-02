import { describe, expect, it } from "vitest";
import {
  CALLBACK_MIN_LAG_TURNS,
  type FlywheelInput,
  PROSPECTIVE_LAG_TURNS,
  analyzeProspectiveFlywheel,
  distinctiveTokens,
  overlapFraction,
  readConte,
} from "./flywheel-prospective";

/**
 * The §6.8 prospective adjudication, pure. These fixtures are shaped like a
 * soaked campaign's rows, so the suite's judgment can be proven without a soak
 * (and without a model call — the suite makes none by design).
 */

function conte(over: Record<string, unknown> = {}): unknown {
  return { turn_id: 1, tier: "genga", memories: [], callbacks: [], spotlight_hints: [], ...over };
}

function playedTurns(count: number, extra: Record<number, unknown> = {}): FlywheelInput["turns"] {
  const turns: FlywheelInput["turns"] = [];
  for (let n = 1; n <= count; n++) {
    turns.push({
      turnNumber: n,
      playerInput: "I keep moving, eyes open.",
      status: "complete",
      conte: extra[n] ?? conte(),
    });
  }
  return turns;
}

/** A run that satisfies every probe: a deep unechoed surfacing, a settled seed
 *  ledger, and a Brief line traced to an entity minted long before. */
function healthyRun(): FlywheelInput {
  const surfacing = conte({
    memories: [
      {
        content: "The Red Sash syndicate quietly owns the northern piers",
        layer: "semantic",
        turn_id: 5,
        provenance: "chronicler_g2",
        confidence: 0.9,
      },
    ],
    callbacks: ["the syndicate's unpaid debt at the northern piers"],
  });
  return {
    campaignId: "camp",
    turns: playedTurns(60, { 50: surfacing }),
    seeds: [
      {
        description: "the fixer's missing brother is aboard the trawler",
        expectedPayoff: "the brother surfaces as the mark",
        status: "resolved",
        plantedTurn: 6,
        resolvedTurn: 44,
        resolvedBy: "adjudicator_payoff",
        mentionCount: 3,
        candidates: [{ t: 30, s: 0.7, adj: true }],
        provenance: "director",
      },
    ],
    entities: [{ name: "syndicate", turnId: 5 }],
  };
}

describe("readConte", () => {
  it("reads memories, callbacks, spotlight hints and the pacer's must_reference", () => {
    const read = readConte(
      conte({
        memories: [{ content: "a fact", layer: "episodic", turn_id: 3 }],
        callbacks: ["a callback"],
        spotlight_hints: ["give Jet the beat"],
        pacer_beat: { beat_classification: "quiet", must_reference: ["the trawler"] },
      }),
    );
    expect(read.memories).toEqual([{ content: "a fact", layer: "episodic", turnId: 3 }]);
    expect(read.callbacks).toEqual(["a callback"]);
    expect(read.spotlightHints).toEqual(["give Jet the beat"]);
    expect(read.mustReference).toEqual(["the trawler"]);
  });

  it("drops malformed entries instead of throwing the turn's evidence away", () => {
    const read = readConte({
      memories: [null, { content: "no turn id" }, 7],
      callbacks: [1, "ok"],
    });
    expect(read.memories).toEqual([]);
    expect(read.callbacks).toEqual(["ok"]);
    expect(readConte(null).memories).toEqual([]);
  });
});

describe("token attribution", () => {
  it("keeps only distinctive words", () => {
    const tokens = distinctiveTokens("The rain is on the northern piers");
    expect(tokens.has("northern")).toBe(true);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("rain")).toBe(false);
  });

  it("measures how much of the material the corpus repeats", () => {
    const material = distinctiveTokens("syndicate northern piers");
    expect(overlapFraction(material, distinctiveTokens("the syndicate owns northern piers"))).toBe(
      1,
    );
    expect(overlapFraction(material, distinctiveTokens("nothing familiar here"))).toBe(0);
    expect(overlapFraction(new Set<string>(), distinctiveTokens("anything"))).toBe(0);
  });
});

describe("analyzeProspectiveFlywheel", () => {
  const probe = (input: FlywheelInput, name: string) => {
    const found = analyzeProspectiveFlywheel(input).probes.find((p) => p.name === name);
    if (!found) throw new Error(`no probe named ${name}`);
    return found;
  };

  it("passes a run where the engine reached back, settled a seed, and called back", () => {
    const { probes } = analyzeProspectiveFlywheel(healthyRun());
    expect(probes.filter((p) => p.required && !p.ok)).toEqual([]);
  });

  it("names the layer that supplied the surfacing (§6.8's trace requirement)", () => {
    expect(probe(healthyRun(), "layer-attribution").detail).toContain("semantic");
    expect(probe(healthyRun(), "reach").detail).toContain("planted turn 5");
  });

  it("excludes the Critical layer — guaranteed injection is not prospection", () => {
    const run = healthyRun();
    run.turns = playedTurns(60, {
      50: conte({
        memories: [{ content: "the sister died on Ganymede", layer: "critical", turn_id: 4 }],
      }),
    });
    const reach = probe(run, "reach");
    expect(reach.ok).toBe(false);
    expect(reach.detail).toContain("critical-layer injections excluded");
  });

  it("excludes the self-boosting hot_baseline layer — heat carried it, nothing reached for it", () => {
    const run = healthyRun();
    run.turns = playedTurns(60, {
      50: conte({
        memories: [
          {
            content: "The Red Sash syndicate quietly owns the northern piers",
            layer: "hot_baseline",
            turn_id: 5,
          },
        ],
      }),
    });
    const reach = probe(run, "reach");
    expect(reach.ok).toBe(false);
    expect(reach.detail).toContain("echo via heat");
  });

  it("fails a memory that RODE every conte from turn 5 to turn 50 (copy-forward, not reach)", () => {
    const run = healthyRun();
    const memory = {
      content: "The Red Sash syndicate quietly owns the northern piers",
      layer: "semantic",
      turn_id: 5,
    };
    // The heat loop keeps it admitted every single turn after the plant, so its
    // lag grows one turn per turn for free — the shape §6.8 must NOT accept.
    const riding: Record<number, unknown> = {};
    for (let n = 6; n <= 50; n++) riding[n] = conte({ memories: [memory] });
    run.turns = playedTurns(60, riding);
    const reach = probe(run, "reach");
    expect(reach.ok).toBe(false);
    expect(reach.detail).toContain("echo via heat");
    // And it is flagged as a ride, not silently absorbed into the script-echo
    // count — the two are different diagnoses.
    expect(reach.detail).toContain("present in the contes across the lag span");
  });

  it("one clean surfacing still reaches when the SAME material returns later", () => {
    // Turn 45 is a genuine reach (absent from every conte between 5 and 45);
    // turn 50's re-injection is the ride, and only turn 45 may be counted.
    const memory = {
      content: "The Red Sash syndicate quietly owns the northern piers",
      layer: "semantic",
      turn_id: 5,
    };
    const run = healthyRun();
    run.turns = playedTurns(60, {
      45: conte({ memories: [memory] }),
      50: conte({ memories: [memory] }),
    });
    const reach = probe(run, "reach");
    expect(reach.ok).toBe(true);
    expect(reach.detail).toContain("surfaced turn 45");
    expect(reach.detail).toContain("1 present in the contes across the lag span");
  });

  it("excludes material the script kept saying — that proves retrieval, not prospection", () => {
    const run = healthyRun();
    const echoed = playedTurns(60, {
      50: conte({
        memories: [
          {
            content: "The Red Sash syndicate quietly owns the northern piers",
            layer: "semantic",
            turn_id: 5,
          },
        ],
      }),
    });
    // The player keeps naming the material between the plant and the surfacing.
    for (const turn of echoed) {
      if (turn.turnNumber > 5 && turn.turnNumber < 50) {
        turn.playerInput = "I ask about the Red Sash syndicate and the northern piers again";
      }
    }
    run.turns = echoed;
    const reach = probe(run, "reach");
    expect(reach.ok).toBe(false);
    expect(reach.detail).toContain("echoed by the script");
  });

  it("fails a surfacing that did not reach far enough", () => {
    const run = healthyRun();
    run.turns = playedTurns(60, {
      50: conte({
        memories: [
          {
            content: "The Red Sash syndicate quietly owns the northern piers",
            layer: "semantic",
            turn_id: 50 - (PROSPECTIVE_LAG_TURNS - 1),
          },
        ],
      }),
    });
    expect(probe(run, "reach").ok).toBe(false);
  });

  it("fails an empty seed ledger by name — nothing was planted to pay off", () => {
    const run = healthyRun();
    run.seeds = [];
    const seedProbe = probe(run, "seed-ledger-turns");
    expect(seedProbe.ok).toBe(false);
    expect(seedProbe.detail).toContain("EMPTY");
  });

  it("fails a ledger that plants and never settles (the audit's 12 live, zero paid)", () => {
    const run = healthyRun();
    run.seeds = run.seeds.map((s) => ({
      ...s,
      status: "planted",
      resolvedTurn: null,
      resolvedBy: null,
    }));
    expect(probe(run, "seed-ledger-turns").ok).toBe(false);
  });

  it("fails a callback channel that only ever echoes the current beat", () => {
    const run = healthyRun();
    run.turns = playedTurns(60, {
      50: conte({
        memories: [
          {
            content: "The Red Sash syndicate quietly owns the northern piers",
            layer: "semantic",
            turn_id: 5,
          },
        ],
        // Attributable to the entity, but minted only a turn before — no reach.
        callbacks: ["the syndicate's courier"],
      }),
    });
    run.entities = [{ name: "syndicate", turnId: 50 - (CALLBACK_MIN_LAG_TURNS - 1) }];
    expect(probe(run, "callback-channel").ok).toBe(false);
  });

  it("ignores incomplete turns — a failed turn planted nothing", () => {
    const run = healthyRun();
    run.turns.push({
      turnNumber: 61,
      playerInput: "x",
      status: "failed",
      conte: conte({
        memories: [{ content: "never happened", layer: "semantic", turn_id: 1 }],
      }),
    });
    const { details } = analyzeProspectiveFlywheel(run);
    expect(details[0]).toContain("60 completed turns");
  });
});
