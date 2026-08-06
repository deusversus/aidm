import { describe, expect, it } from "vitest";
import {
  type Arm,
  type ArmTally,
  MIN_USABLE_REPS,
  REPS,
  type RepOutcome,
  summarizeArms,
  tallyReps,
} from "./renderer-efficacy";

/**
 * The §10.2 verdict machinery, pure. The suite itself is `requiresLlm` and
 * costs real narration calls, so the HARDENING would otherwise be unverifiable
 * without spending — these fixtures replay the four red runs of 2026-08-05 as
 * synthetic rep outcomes and pin what each one should have said.
 */

const arm = (name: string, tally: ArmTally): Arm => ({ name, tally, detail: "" });

describe("tallyReps — majority of usable reps", () => {
  it("a clean sweep passes", () => {
    expect(tallyReps(["toward", "toward", "toward"]).verdict).toBe("pass");
  });

  it("2 of 3 toward is a majority", () => {
    expect(tallyReps(["toward", "away", "toward"]).verdict).toBe("pass");
  });

  it("2 of 3 away is a REGRESSION — the one red that means something", () => {
    const t = tallyReps(["away", "toward", "away"]);
    expect(t.verdict).toBe("fail");
    expect(t.away).toBe(2);
  });

  it("a 1/1/1 split proves nothing", () => {
    expect(tallyReps(["toward", "away", "tie"]).verdict).toBe("unproven");
  });

  it("RUN 1 REPLAY — a tie is not a regression", () => {
    // The pre-hardening `dWith >= dWithout` read an exact tie as FAIL.
    expect(tallyReps(["tie", "tie", "tie"]).verdict).toBe("unproven");
    expect(tallyReps(["toward", "tie", "tie"]).verdict).toBe("unproven");
  });

  it("RUN 4 REPLAY — a 529 across the arm is UNPROVEN, never FAIL", () => {
    const t = tallyReps(["unproven", "unproven", "unproven"]);
    expect(t.verdict).toBe("unproven");
    expect(t.usable).toBe(0);
  });

  // RUN 2 REPLAY — a DIFFERENT axis reddened each run. That is exactly what one
  // usable draw per arm produces: sampling noise reading as a moving
  // regression. The repair is the usable-rep floor, not a scorer tweak.
  it("one lonely usable rep cannot carry an arm (the single-sample failure mode)", () => {
    expect(tallyReps(["toward", "unproven", "unproven"]).verdict).toBe("unproven");
    expect(tallyReps(["away", "unproven", "unproven"]).verdict).toBe("unproven");
    expect(MIN_USABLE_REPS).toBeGreaterThan(1);
  });

  it("two usable reps agreeing DO carry it", () => {
    expect(tallyReps(["toward", "toward", "unproven"]).verdict).toBe("pass");
    expect(tallyReps(["away", "away", "unproven"]).verdict).toBe("fail");
    expect(tallyReps(["toward", "away", "unproven"]).verdict).toBe("unproven");
  });

  it("the default rep count is odd, so a usable majority always exists", () => {
    expect(REPS % 2).toBe(1);
  });

  it("counts every outcome class for the detail line", () => {
    const t = tallyReps(["toward", "away", "tie", "unproven"]);
    expect(t).toMatchObject({ toward: 1, away: 1, tie: 1, unproven: 1, usable: 3 });
  });
});

describe("summarizeArms — 'the charter regressed' vs 'nothing was proven'", () => {
  const pass = tallyReps(["toward", "toward", "toward"]);
  const fail = tallyReps(["away", "away", "away"]);
  const unproven = tallyReps(["unproven", "unproven", "unproven"]);

  it("every arm proven → pass", () => {
    const out = summarizeArms([arm("darkness→9", pass), arm("control pacing", pass)]);
    expect(out.status).toBe("pass");
    expect(out.failures).toEqual([]);
    expect(out.summary).toContain("the charter holds on every arm");
  });

  it("one arm regressed → fail, and the summary NAMES it", () => {
    const out = summarizeArms([arm("darkness→9", fail), arm("comedy→9", pass)]);
    expect(out.status).toBe("fail");
    expect(out.failures).toHaveLength(1);
    expect(out.summary).toContain("REGRESSED");
    expect(out.summary).toContain("darkness→9");
  });

  it("RUN 4 REPLAY — nothing proven at all is SKIPPED (measured nothing), not a pass", () => {
    const out = summarizeArms([arm("darkness→9", unproven), arm("comedy→9", unproven)]);
    expect(out.status).toBe("skipped");
    expect(out.failures).toEqual([]);
    expect(out.summary).toContain("INSTRUMENT proved nothing");
  });

  it("a partial evidence gap passes on what was proven and says what was not", () => {
    const out = summarizeArms([arm("darkness→9", pass), arm("comedy→9", unproven)]);
    expect(out.status).toBe("pass");
    expect(out.summary).toContain("evidence gap, not a charter finding");
    expect(out.summary).toContain("comedy→9");
  });

  it("RUN 3 REPLAY — a control arm that really drifted still reddens the run", () => {
    // Control drift is a REAL §10.2 finding (collateral damage); the repair
    // was never to stop reporting it, only to stop calling one draw a verdict.
    const out = summarizeArms([
      arm("darkness→9", pass),
      arm("control interiority under darkness", fail),
    ]);
    expect(out.status).toBe("fail");
    expect(out.summary).toContain("control interiority under darkness");
  });

  it("a regression outranks an evidence gap in the summary", () => {
    const out = summarizeArms([arm("a", fail), arm("b", unproven), arm("c", pass)]);
    expect(out.status).toBe("fail");
    expect(out.summary).toContain("1 proven, 1 REGRESSED, 1 unproven");
  });

  const outcomes: RepOutcome[] = ["toward", "away", "tie", "unproven"];
  it("the outcome vocabulary is closed (a typo cannot silently become 'usable')", () => {
    expect(tallyReps(outcomes).usable + tallyReps(outcomes).unproven).toBe(outcomes.length);
  });
});
