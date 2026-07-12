import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import {
  PACER_PHASES,
  PHASE_GATES,
  type PacerArcState,
  type PacerPhase,
} from "@/lib/types/direction";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PACER_TIMEBOX_MS,
  type PacerInput,
  beatShapeAlternatives,
  beatShapeToken,
  repeatedBeatShape,
  runPacer,
  stallDirective,
} from "../pacer";

/**
 * The full Pacer (§7.2, C7): pure clamp logic over v3's play-tested stall
 * table. callProbe is mocked, so the suite is hermetic — no DB, no network,
 * no Fable. Every assertion is the code side of axiom 3: the model proposes,
 * the stall table disposes.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn() };
});

const mockProbe = vi.mocked(callProbe);

const baseDirective: Record<string, unknown> = {
  beat_classification: "investigation",
  escalation_target: "0.3",
  tone: "wary",
  must_reference: [],
  avoid: [],
  strength: "suggestion",
};

/** Arm the probe with a directive (spread over the base). */
function arm(over: Record<string, unknown> = {}): void {
  mockProbe.mockImplementation(() => Promise.resolve({ ...baseDirective, ...over }) as never);
}

function makeArc(over: Partial<PacerArcState> = {}): PacerArcState {
  return { phase: "setup", turnsInPhase: 0, tensionLevel: 0.3, ...over };
}

function makeInput(over: Partial<PacerInput> = {}): PacerInput {
  return {
    intent: "EXPLORATION, epicness 0.40",
    playerInput: "I search the room",
    recentBeats: [],
    arcState: null,
    ...over,
  };
}

beforeEach(() => {
  mockProbe.mockReset();
});

describe("PacerContract", () => {
  it("timebox is frozen at 6s (§5.5 degrade ladder step)", () => {
    expect(PACER_TIMEBOX_MS).toBe(6_000);
  });
});

describe("stallDirective — v3 stall table, every row edge", () => {
  // [phase, strongAfter, overrideAfter | null]
  const rows: Array<[PacerPhase, number, number | null]> = [
    ["setup", 6, 10],
    ["rising", 8, 12],
    ["escalation", 6, 10],
    ["climax", 4, 8],
    ["falling", 6, null],
    ["resolution", 4, null],
  ];

  for (const [phase, strongAfter, overrideAfter] of rows) {
    it(`${phase}: floor rises only STRICTLY past each threshold`, () => {
      // At the strong threshold → not yet admitted.
      expect(stallDirective(makeArc({ phase, turnsInPhase: strongAfter })).floor).toBe(
        "suggestion",
      );
      // One past → strong, carrying the gate's strong action.
      const strong = stallDirective(makeArc({ phase, turnsInPhase: strongAfter + 1 }));
      expect(strong.floor).toBe("strong");
      expect(strong.action).toBe(PHASE_GATES[phase].strongAction);

      if (overrideAfter === null) {
        // No override row → never override, even at a catastrophic overstay.
        expect(stallDirective(makeArc({ phase, turnsInPhase: 99 })).floor).toBe("strong");
      } else {
        // At the override threshold → still only strong.
        expect(stallDirective(makeArc({ phase, turnsInPhase: overrideAfter })).floor).toBe(
          "strong",
        );
        // One past → override, carrying the gate's override action.
        const over = stallDirective(makeArc({ phase, turnsInPhase: overrideAfter + 1 }));
        expect(over.floor).toBe("override");
        expect(over.action).toBe(PHASE_GATES[phase].overrideAction);
      }
    });
  }

  it("turnsInPhase 0 is suggestion in every phase", () => {
    for (const phase of PACER_PHASES) {
      expect(stallDirective(makeArc({ phase, turnsInPhase: 0 })).floor).toBe("suggestion");
    }
  });
});

describe("runPacer — strength clamp (axiom 3, code enforces)", () => {
  it("clamp-down: model proposes override in setup at turn 3 → demoted to strong + note", async () => {
    arm({ strength: "override", beat_classification: "standoff" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "setup", turnsInPhase: 3 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.pacingNote).toContain("demoted to strong");
    expect(res.timedOut).toBe(false);
  });

  it("raise-up: setup stalling at turn 7 → strong floor + the strong action on must_reference", async () => {
    arm({ strength: "suggestion", beat_classification: "wander", must_reference: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "setup", turnsInPhase: 7 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.beat?.must_reference).toContain(PHASE_GATES.setup.strongAction);
    expect(res.pacingNote).toContain("phase gate");
  });

  it("raise-up: setup stalling at turn 11 → override floor + the override action", async () => {
    const overrideAction = PHASE_GATES.setup.overrideAction as string;
    arm({ strength: "suggestion", beat_classification: "wander", must_reference: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "setup", turnsInPhase: 11 }) }),
    );
    expect(res.beat?.strength).toBe("override");
    expect(res.beat?.must_reference).toContain(overrideAction);
    expect(res.pacingNote).toContain(overrideAction);
  });

  it("an in-gate override is honored (rising turn 13 → override admitted)", async () => {
    arm({ strength: "override", beat_classification: "breaking" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 13 }) }),
    );
    expect(res.beat?.strength).toBe("override");
    // Admitted by the gate → no demotion note.
    expect(res.pacingNote ?? "").not.toContain("demoted");
    // The stall nudge rides regardless — the gate drives it, not the raise
    // direction (C7 audit: a model already at the floor silently lost v3's
    // corrective action).
    expect(res.beat?.must_reference).toContain(PHASE_GATES.rising.overrideAction as string);
  });

  it("the gate nudge fires even when the model already proposes the floor (stalling setup, model says strong)", async () => {
    arm({ strength: "strong", beat_classification: "wander", must_reference: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "setup", turnsInPhase: 7 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.beat?.must_reference).toContain(PHASE_GATES.setup.strongAction);
    expect(res.pacingNote).toContain("phase gate");
  });

  it("no nudge below the gate (setup turn 3, model says strong — advisory strength stands, no gate action)", async () => {
    arm({ strength: "strong", beat_classification: "standoff", must_reference: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "setup", turnsInPhase: 3 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.beat?.must_reference).not.toContain(PHASE_GATES.setup.strongAction);
    expect(res.pacingNote ?? "").not.toContain("phase gate");
  });
});

describe("runPacer — the high-tension climax rule (v3)", () => {
  it("tension > 0.8 outside climax → strength ≥ strong and a climax transition", async () => {
    arm({ strength: "suggestion", beat_classification: "brewing" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2, tensionLevel: 0.85 }) }),
    );
    expect(res.phaseTransition).toBe("climax");
    expect(res.beat?.strength).toBe("strong");
    expect(res.pacingNote).toContain("climax suggested");
  });

  it("tension exactly at 0.8 does NOT trip the rule (strictly greater)", async () => {
    arm({ strength: "suggestion", beat_classification: "brewing" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2, tensionLevel: 0.8 }) }),
    );
    expect(res.phaseTransition).toBeUndefined();
    expect(res.beat?.strength).toBe("suggestion");
  });

  it("already in climax → the rule is inert", async () => {
    arm({ strength: "suggestion", beat_classification: "peak" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "climax", turnsInPhase: 1, tensionLevel: 0.95 }) }),
    );
    expect(res.phaseTransition).toBeUndefined();
    expect(res.beat?.strength).toBe("suggestion");
  });
});

describe("runPacer — phase transition (suggested, never applied)", () => {
  it("passes a model transition through when it changes phase", async () => {
    arm({ strength: "suggestion", phase_transition: "escalation" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2 }) }),
    );
    expect(res.phaseTransition).toBe("escalation");
  });

  it("drops a no-op self-transition", async () => {
    arm({ strength: "suggestion", phase_transition: "rising" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2 }) }),
    );
    expect(res.phaseTransition).toBeUndefined();
  });
});

describe("runPacer — null arc state (no Director has run)", () => {
  it("holds strength at suggestion regardless of the model proposal", async () => {
    arm({
      strength: "override",
      beat_classification: "quiet",
      must_reference: ["the open hatch"],
      avoid: ["rushing the reveal"],
      phase_transition: "climax",
    });
    const res = await runPacer(DEV_TIER_SELECTION, makeInput({ arcState: null }));
    expect(res.beat?.strength).toBe("suggestion");
    expect(res.beat?.beat_classification).toBe("quiet");
    expect(res.beat?.must_reference).toEqual(["the open hatch"]);
    expect(res.beat?.avoid).toEqual(["rushing the reveal"]);
    expect(res.phaseTransition).toBeUndefined();
    expect(res.promoteEffort).toBe(false);
    expect(res.pacingNote).toContain("no arc state");
  });
});

describe("runPacer — timebox (a slow Pacer never stalls Phase A)", () => {
  it("a never-resolving probe times out → no beat, no promotion", async () => {
    mockProbe.mockImplementation(() => new Promise(() => {}) as never);
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "escalation", turnsInPhase: 3 }) }),
      20,
    );
    expect(res.timedOut).toBe(true);
    expect(res.beat).toBeUndefined();
    expect(res.promoteEffort).toBe(false);
    expect(res.phaseTransition).toBeUndefined();
  });

  it("a rejected probe degrades exactly like a timeout", async () => {
    mockProbe.mockImplementation(() => Promise.reject(new Error("probe boom")) as never);
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2 }) }),
      50,
    );
    expect(res.timedOut).toBe(true);
    expect(res.beat).toBeUndefined();
    expect(res.promoteEffort).toBe(false);
  });
});

describe("beat-shape vocabulary helpers (§7.2/§5.3)", () => {
  it("normalizes a compound classification to its shape prefix", () => {
    expect(beatShapeToken("climax_silent_pressure")).toBe("climax");
    expect(beatShapeToken("Setup Ritual Grounding")).toBe("setup");
    expect(beatShapeToken("investigation")).toBe("investigation");
  });

  it("leading articles never form a rut token (C8 audit #3)", () => {
    expect(beatShapeToken("the reckoning")).toBe("reckoning");
    expect(beatShapeToken("a quiet moment")).toBe("quiet");
    // Three different "the …" beats are NOT a rut.
    expect(repeatedBeatShape(["the reckoning", "the calm", "the chase"])).toBeUndefined();
    // But three genuinely same-shaped freeform beats are.
    expect(repeatedBeatShape(["the chase begins", "chase through rain", "a chase again"])).toBe(
      "chase",
    );
  });

  it("detects a 3-run only when all three shapes match", () => {
    expect(repeatedBeatShape(["climax_a", "climax_b", "climax_c"])).toBe("climax");
    // Flavors differ, shape is stuck — still a rut.
    expect(repeatedBeatShape(["climax_silent", "climax_ambush", "climax_reveal"])).toBe("climax");
    expect(repeatedBeatShape(["climax_a", "rising_b", "climax_c"])).toBeUndefined();
    expect(repeatedBeatShape(["climax_a", "climax_b"])).toBeUndefined();
  });

  it("offers two vocabulary alternatives, never the repeated shape", () => {
    const [a, b] = beatShapeAlternatives("climax");
    expect(a).not.toBe("climax");
    expect(b).not.toBe("climax");
    expect(a).not.toBe(b);
    expect(PACER_PHASES).toContain(a);
    expect(PACER_PHASES).toContain(b);
  });
});

describe("runPacer — beat-shape variety (§7.2/§5.3: the live watch item)", () => {
  it("three same-shape scenes running → advisory on `avoid` naming two alternatives", async () => {
    arm({ strength: "suggestion", beat_classification: "climax_reveal", avoid: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({
        arcState: null,
        recentBeats: ["climax_silent_pressure", "climax_ambush", "climax_reveal"],
      }),
    );
    const advisory = res.beat?.avoid.find((a) => a.includes("vary the shape"));
    expect(advisory).toBeDefined();
    expect(advisory).toContain("the last three scenes all landed as climax");
    expect(advisory).toMatch(/consider \w+ or \w+/);
    // The rut itself is never offered as an alternative.
    expect(advisory).not.toMatch(/consider climax|or climax/);
  });

  it("a freeform (non-vocabulary) rut gets the honest generic nudge, never fake phase alternatives (C8 audit #3)", async () => {
    arm({ strength: "suggestion", beat_classification: "standoff_tense", avoid: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({
        arcState: null,
        recentBeats: ["standoff_alley", "standoff_rooftop", "standoff_tense"],
      }),
    );
    const advisory = res.beat?.avoid.find((a) => a.includes("landed the same way"));
    expect(advisory).toBeDefined();
    expect(advisory).toContain("(standoff)");
    // No phase-vocabulary alternatives smuggled in for a shape they can't replace.
    expect(advisory).not.toMatch(/consider \w+ or \w+/);
  });

  it("two same + one different → no pressure (the 2-same guard)", async () => {
    arm({ strength: "suggestion", beat_classification: "rising_probe", avoid: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({
        arcState: null,
        recentBeats: ["climax_silent", "climax_ambush", "rising_probe"],
      }),
    );
    expect(res.beat?.avoid.some((a) => a.includes("vary the shape"))).toBe(false);
  });

  it("fewer than three completed beats → no pressure", async () => {
    arm({ strength: "suggestion", beat_classification: "setup_quiet", avoid: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: null, recentBeats: ["setup_a", "setup_b"] }),
    );
    expect(res.beat?.avoid.some((a) => a.includes("vary the shape"))).toBe(false);
  });

  it("the variety directive never elevates strength (advisory only, axiom 3)", async () => {
    // A non-stalling arc that sits at suggestion: the rut must not push it up.
    arm({ strength: "suggestion", beat_classification: "setup_quiet", avoid: [] });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({
        arcState: makeArc({ phase: "setup", turnsInPhase: 1 }),
        recentBeats: ["setup_a", "setup_b", "setup_c"],
      }),
    );
    expect(res.beat?.strength).toBe("suggestion");
    expect(res.beat?.avoid.some((a) => a.includes("vary the shape"))).toBe(true);
  });
});

describe("runPacer — promoteEffort truth table (§3: trivial ≠ functionally trivial)", () => {
  it("escalation phase, gate-raised to strong → promote", async () => {
    arm({ strength: "suggestion" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "escalation", turnsInPhase: 7 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.promoteEffort).toBe(true);
  });

  it("escalation phase but still suggestion → no promote", async () => {
    arm({ strength: "suggestion" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "escalation", turnsInPhase: 2 }) }),
    );
    expect(res.beat?.strength).toBe("suggestion");
    expect(res.promoteEffort).toBe(false);
  });

  it("rising phase at strong but not climbing → no promote", async () => {
    arm({ strength: "suggestion" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 9 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.phaseTransition).toBeUndefined();
    expect(res.promoteEffort).toBe(false);
  });

  it("a set transition makes a strong beat promote even mid-rising", async () => {
    arm({ strength: "strong", phase_transition: "escalation" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "rising", turnsInPhase: 2 }) }),
    );
    expect(res.phaseTransition).toBe("escalation");
    expect(res.beat?.strength).toBe("strong");
    expect(res.promoteEffort).toBe(true);
  });

  it("climax phase, gate-raised to strong → promote", async () => {
    arm({ strength: "suggestion" });
    const res = await runPacer(
      DEV_TIER_SELECTION,
      makeInput({ arcState: makeArc({ phase: "climax", turnsInPhase: 5 }) }),
    );
    expect(res.beat?.strength).toBe("strong");
    expect(res.promoteEffort).toBe(true);
  });
});
