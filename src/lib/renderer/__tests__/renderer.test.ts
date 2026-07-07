import { approxTokens } from "@/lib/blocks/tokens";
import type { PencilMark } from "@/lib/types/marks";
import { describe, expect, it } from "vitest";
import { renderAmendments } from "../amendments";
import { renderSceneShape } from "../scene-shape";
import {
  SETTEI_MAX_RENDERED_AXES,
  SETTEI_TOKEN_TARGET,
  extremeAxes,
  rankAxes,
  renderSettei,
} from "../settei";
import { BEBOP_DNA, bebopContract } from "./fixtures";

const mark = (topic: string, direction: string, superseded = false): PencilMark => ({
  id: `mark_${topic}`,
  kind: "axis",
  topic,
  direction,
  evidence: "test",
  turn_id: 1,
  provenance: "meta_booth",
  confidence: 0.9,
  ...(superseded ? { superseded_by: "mark_x" } : {}),
});

describe("extreme-axis selection (§4.4a)", () => {
  it("finds Bebop's nine extremes and ranks distance-then-schema-order", () => {
    const extremes = extremeAxes(BEBOP_DNA);
    expect(extremes).toHaveLength(9);
    const ranked = rankAxes(BEBOP_DNA, extremes);
    // d3: moral_complexity, empathy (schema order); then d2 in schema order.
    expect(ranked.slice(0, 2)).toEqual(["moral_complexity", "empathy"]);
    expect(ranked.slice(2, 6)).toEqual(["continuity", "optimism", "darkness", "fidelity"]);
  });

  it("arcRelevance breaks distance ties ahead of schema order", () => {
    const ranked = rankAxes(BEBOP_DNA, extremeAxes(BEBOP_DNA), { register: 1 });
    expect(ranked[2]).toBe("register");
  });
});

describe("renderSettei (§4.4a)", () => {
  const settei = renderSettei({ contract: bebopContract(), marks: [] });

  it("renders ≤6 axes; the charter lands inside the §4.4a budget", () => {
    expect(settei.renderedAxes.length).toBeLessThanOrEqual(SETTEI_MAX_RENDERED_AXES);
    expect(settei.charterTokens).toBeGreaterThanOrEqual(SETTEI_TOKEN_TARGET.min);
    expect(settei.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);
    // Whole Block 1 = charter + the world-rules command block.
    expect(settei.tokens).toBeGreaterThan(settei.charterTokens);
    expect(approxTokens(settei.text)).toBe(settei.tokens);
  });

  it("picks exemplars for the most extreme covered axes at the matching band", () => {
    expect(settei.exemplarIds[0]).toBe("moral_complexity_b9_vinland");
    expect(settei.exemplarIds[1]).toBe("empathy_b9_fruitsbasket");
    // Third exemplar rides only if the budget holds it (§4.4a: 2–3).
    expect(settei.exemplarIds.length).toBeGreaterThanOrEqual(2);
    if (settei.exemplarIds.length === 3) {
      expect(settei.exemplarIds[2]).toBe("continuity_b1_kino");
      expect(settei.trims).toHaveLength(0);
    } else {
      expect(settei.trims.length).toBeGreaterThan(0);
    }
  });

  it("carries the hard core, the spark, and the voice fingerprint verbatim", () => {
    expect(settei.text).toContain("Bullets kill");
    expect(settei.text).toContain("NEVER contradict: Spike's past");
    expect(settei.text).toContain("Whatever happens, happens");
    expect(settei.text).toContain("The spark");
    expect(settei.text).toContain("deflection as intimacy");
  });

  it("summarizes only TRUE MIDS by group — unrendered extremes are never counter-pressed", () => {
    expect(settei.renderedAxes).not.toContain("cruelty");
    expect(settei.text).toMatch(/morals and knowledge:.*cruelty/);
    // register=7 and reflexivity=3 were cut by the ≤6 cap; telling the KA
    // to keep them "moderate" would press against the premise (C1 audit).
    const focusLine = settei.text.split("\n").find((l) => l.startsWith("focus and style:"));
    expect(focusLine).toBeDefined();
    expect(focusLine).not.toContain("register");
    const realismLine = settei.text.split("\n").find((l) => l.startsWith("realism and form:"));
    expect(realismLine).not.toContain("reflexivity");
    expect(realismLine).not.toContain("fidelity");
  });

  it("surfaces uncovered premise extremes instead of silently pressing or cutting them", () => {
    const contract = bebopContract();
    contract.active.treatment.avant_garde = 9; // extreme, outside COVERED_AXES
    const s = renderSettei({ contract, marks: [] });
    expect(s.uncoveredExtremes).toContain("avant_garde");
    expect(s.renderedAxes).not.toContain("avant_garde");
  });

  it("renders standing marks and excludes superseded ones (shade, never mutate)", () => {
    const withMarks = renderSettei({
      contract: bebopContract(),
      marks: [mark("emotional_register", "less flowery"), mark("pacing", "stale note", true)],
    });
    expect(withMarks.text).toContain("less flowery");
    expect(withMarks.text).not.toContain("stale note");
    // Shading never mutates the premise: treatment values unchanged.
    expect(BEBOP_DNA.emotional_register).toBe(6);
  });
});

describe("renderAmendments (§4.4b)", () => {
  it("renders override pressure, retake direction, and fresh marks inside budget", () => {
    const a = renderAmendments({
      arcOverride: {
        arc_name: "The Syndicate Closes In",
        started_turn: 40,
        transition_signal: "Spike walks out of the church",
        dna: { darkness: 9 },
      },
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 6 }],
      freshMarks: [mark("register", "keep it plainer")],
    });
    expect(a.text).toContain("darkness plays at 9/10");
    expect(a.text).toContain("until: Spike walks out of the church");
    expect(a.text).toContain("Pull it up");
    expect(a.text).toContain("keep it plainer");
    expect(a.tokens).toBeLessThanOrEqual(250);
  });

  it("empty inputs render nothing", () => {
    const a = renderAmendments({ sakkanNotes: [], freshMarks: [] });
    expect(a.text).toBe("");
    expect(a.tokens).toBe(0);
  });

  it("budget trims drop fresh marks, never retakes", () => {
    const marks = Array.from({ length: 40 }, (_, i) =>
      mark(`topic_${i}`, `a long calibration direction about restraint number ${i}`),
    );
    const a = renderAmendments({
      sakkanNotes: [{ axis: "comedy", active: 1, observed: 5 }],
      freshMarks: marks,
    });
    expect(a.tokens).toBeLessThanOrEqual(250);
    expect(a.text).toContain("RETAKE");
    expect(a.trims.length).toBeGreaterThan(0);
  });
});

describe("renderSceneShape (§4.4c)", () => {
  it("renders Framing + arc state inside the 150-token budget", () => {
    const s = renderSceneShape(bebopContract().active.framing, {
      arcName: "Terra Firma",
      phase: "rising",
      trajectoryNote: "the debt comes due tonight",
    });
    expect(s.tokens).toBeLessThanOrEqual(150);
    expect(s.text).toContain("someone besides the lead gets a beat");
    expect(s.text).toContain("Terra Firma");
    expect(s.text).toContain("debt comes due");
  });
});
