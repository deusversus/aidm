import { approxTokens } from "@/lib/blocks/tokens";
import type { AxisName } from "@/lib/types/grounding";
import type { PencilMark } from "@/lib/types/marks";
import { describe, expect, it, vi } from "vitest";

// M2-C6 closed real coverage at all 24 axes; the uncovered-extreme surfacing
// test recreates the future-axis gap by carving one axis back out. Every
// other test in this file sees the same 23-axis set — none renders
// avant_garde as an extreme except the gap test itself.
vi.mock("@/lib/types/grounding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/types/grounding")>();
  return {
    ...actual,
    COVERED_AXES: actual.COVERED_AXES.filter((a) => a !== "avant_garde"),
  };
});
import {
  AMENDMENTS_ESCALATED_TOKEN_MAX,
  AMENDMENTS_TOKEN_MAX,
  PUNCH_THROUGH_TURNS,
  renderAmendments,
} from "../amendments";
import { renderSceneShape } from "../scene-shape";
import {
  SETTEI_MAX_RENDERED_AXES,
  SETTEI_TOKEN_TARGET,
  extremeAxes,
  rankAxes,
  renderSettei,
  shadedAxes,
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

describe('the premise governor "How it moves" line (§4.4c reader, M2R2)', () => {
  it("renders the escalation + story-time distillation for the fixture's framing", () => {
    // Bebop's framing: escalation_pattern "stable", story_time_density "months".
    const settei = renderSettei({ contract: bebopContract(), marks: [] });
    expect(settei.text).toContain("How it moves:");
    expect(settei.text).toContain("stakes hold level");
    expect(settei.text).toContain("a seasonal arc");
  });

  it("the escalation distillation tracks the framing value", () => {
    const contract = bebopContract();
    contract.active.framing.escalation_pattern = "exponential";
    contract.active.framing.story_time_density = "incident";
    const settei = renderSettei({ contract, marks: [] });
    expect(settei.text).toContain("each arc multiplies the last");
    expect(settei.text).toContain("scenes hand off in near-real-time");
    expect(settei.text).not.toContain("stakes hold level");
  });
});

describe("the control key in the Settei (§7.5, M2-C8)", () => {
  const keyed = () =>
    bebopContract({
      intensity: {
        death_physics: "death is real, sudden, and cheap — nobody gets a speech",
        lethality_posture: "trends toward an end; losses stay lost",
        hard_lines: [],
        control_key: {
          circumstances: "when a bondmate dies in front of him and the bloodrage takes hold",
        },
      },
    });

  it("renders a bounded permission block when the player cut a key", () => {
    const s = renderSettei({ contract: keyed(), marks: [] });
    expect(s.text).toContain("Control key");
    // The declared circumstance, the brief-duration bound, the inviolable frame.
    expect(s.text).toContain("the bloodrage takes hold");
    expect(s.text).toContain("briefly slip the player's control");
    expect(s.text).toContain("/override melts the key");
    expect(s.charterTokens).toBeGreaterThanOrEqual(SETTEI_TOKEN_TARGET.min);
    expect(s.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);
  });

  it("renders NOTHING new when no key exists (absolute agency is the default, not a rule)", () => {
    // bebopContract's intensity carries no control_key.
    const s = renderSettei({ contract: bebopContract(), marks: [] });
    expect(s.text).not.toContain("Control key");
    expect(s.text).not.toContain("slip the player's control");
  });

  it("the keyed block is Block-1 freight, never charter budget (budget holds)", () => {
    const keyless = renderSettei({ contract: bebopContract(), marks: [] });
    const withKey = renderSettei({ contract: keyed(), marks: [] });
    // Charter is byte-identical; only the world-rules command freight grew.
    expect(withKey.charterTokens).toBe(keyless.charterTokens);
    expect(withKey.tokens).toBeGreaterThan(keyless.tokens);
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
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 6, since_turn: 40 }],
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
      sakkanNotes: [{ axis: "comedy", active: 1, observed: 5, since_turn: 10 }],
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

  it("power_expression renders its craft line (M2R R2 — the SV3 choice finally has a reader)", () => {
    const framing = { ...bebopContract().active.framing, power_expression: "hidden" as const };
    const s = renderSceneShape(framing);
    expect(s.text).toContain("Power on screen:");
    expect(s.text).toContain("dramatic irony");
    expect(s.tokens).toBeLessThanOrEqual(150);
  });

  it("balanced power_expression and not_applicable mode both render nothing", () => {
    const balanced = { ...bebopContract().active.framing, power_expression: "balanced" as const };
    expect(renderSceneShape(balanced).text).not.toContain("Power on screen:");
    const na = {
      ...bebopContract().active.framing,
      power_expression: "overwhelming" as const,
      mode: "not_applicable" as const,
    };
    expect(renderSceneShape(na).text).not.toContain("Power on screen:");
  });
});

describe("the player, known (§6.9 Renderer reader, M2R R4)", () => {
  // A low-pressure contract with budget headroom: all axes centered → few
  // craft blocks → the taste block genuinely fits (Bebop sits at the max,
  // where stage-0 correctly evicts taste — that's the OTHER test).
  const roomy = () => {
    const contract = bebopContract();
    for (const axis of Object.keys(contract.active.treatment) as AxisName[]) {
      contract.active.treatment[axis] = 5;
    }
    return contract;
  };

  it("taste notes render as subordinate cross-campaign priors, capped at 3, most recent kept", () => {
    const settei = renderSettei({
      contract: roomy(),
      marks: [],
      tasteNotes: [
        "oldest — dropped",
        "loves quiet aftermath scenes",
        "reaches for found family",
        "wants villains with a point",
      ],
    });
    expect(settei.text).toContain("## The player, known");
    expect(settei.text).toContain("everything above outranks these");
    expect(settei.text).toContain("loves quiet aftermath scenes");
    expect(settei.text).toContain("wants villains with a point");
    expect(settei.text).not.toContain("oldest — dropped");
  });

  it("at the budget ceiling, taste yields FIRST — premise pressure never pays for priors (R4 audit)", () => {
    // Bebop's charter sits at SETTEI_TOKEN_TARGET.max; a taste block must be
    // the trim that gives, with premise exemplars intact.
    const settei = renderSettei({
      contract: bebopContract(),
      marks: [],
      tasteNotes: ["loves quiet aftermath scenes"],
    });
    expect(settei.text).not.toContain("## The player, known");
    expect(settei.trims.some((t) => t.startsWith("taste note dropped"))).toBe(true);
    expect(settei.exemplarIds.length).toBeGreaterThanOrEqual(2);
    expect(settei.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);
  });

  it("no taste, no section", () => {
    const settei = renderSettei({ contract: bebopContract(), marks: [] });
    expect(settei.text).not.toContain("## The player, known");
  });
});

describe("learned shading (§12, §6.6)", () => {
  // A contract where emotional_register is a low extreme that ranks 7th: six
  // covered axes sit at the |Δ5|=4 max (value 9), emotional_register at 2 (Δ3),
  // everything else centered. Without shading the ≤6 cut leaves it out.
  const D5 = ["darkness", "comedy", "intimacy", "interiority", "cruelty", "epistemics"] as const;
  const shadingContract = () => {
    const contract = bebopContract();
    for (const axis of Object.keys(contract.active.treatment) as AxisName[]) {
      contract.active.treatment[axis] = 5;
    }
    for (const axis of D5) contract.active.treatment[axis] = 9;
    contract.active.treatment.emotional_register = 2;
    return contract;
  };
  const understatement: PencilMark = {
    id: "mark_understatement",
    kind: "craft_note",
    topic: "understatement",
    direction: "keep the emotional register understated — no melodrama",
    evidence: "player note",
    turn_id: 5,
    provenance: "meta_booth",
    confidence: 0.9,
  };

  it("lifts a mark-implicated axis into the rendered ≤6, dropping something else", () => {
    const base = renderSettei({ contract: shadingContract(), marks: [] });
    expect(base.renderedAxes).not.toContain("emotional_register");
    expect(base.renderedAxes.length).toBe(6);

    const shaded = renderSettei({ contract: shadingContract(), marks: [understatement] });
    expect(shaded.renderedAxes).toContain("emotional_register");
    // Budget holds: still ≤6 — the boost displaces an axis, never expands the set.
    expect(shaded.renderedAxes.length).toBeLessThanOrEqual(SETTEI_MAX_RENDERED_AXES);
    // Exemplar pick priority follows the same ranking: the low-extreme passage rides.
    expect(shaded.exemplarIds).toContain("emotional_register_b1_haibane");
    // The mark still renders verbatim (shading is additive, §6.6).
    expect(shaded.text).toContain("no melodrama");
  });

  it("reads marks only; the render mutates neither contract nor marks (§6.6)", () => {
    expect([...shadedAxes([understatement])]).toContain("emotional_register");
    // A bare axis-name topic (the Sakkan's own writer #3) is implicated directly.
    expect([...shadedAxes([mark("comedy", "note")])]).toContain("comedy");

    const contract = shadingContract();
    const before = structuredClone(contract);
    const marks = [understatement];
    const marksBefore = structuredClone(marks);
    renderSettei({ contract, marks });
    expect(contract).toEqual(before);
    expect(marks).toEqual(marksBefore);
  });
});

describe("corrective punch-through (§12, M2-C6)", () => {
  const NOW = 15;
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it("escalates the most-overdue unclosed note only, leading the block with its exemplar", () => {
    const a = renderAmendments({
      // darkness is the older, wider-off retake; intimacy is also eligible but younger.
      sakkanNotes: [
        { axis: "intimacy", active: 9, observed: 4, since_turn: 11 },
        { axis: "darkness", active: 9, observed: 3, since_turn: 8 },
      ],
      freshMarks: [],
      currentTurn: NOW,
      lastSampleTurn: NOW - 1,
    });
    // Exactly one escalation, and it is the most-overdue (darkness, 7 scenes).
    expect(occurrences(a.text, "ESCALATED")).toBe(1);
    expect(a.text).toContain("RETAKE (ESCALATED — off-register 7 scenes): darkness");
    // The escalated axis renders as the escalation, never also as a plain retake.
    expect(a.text).not.toContain("RETAKE (strong): darkness");
    // Its extreme exemplar is quoted inline.
    expect(a.text).toContain("so it feels like this:");
    expect(a.text).toContain("The village had stopped burning");
    // The younger eligible note stays a plain retake, and the escalation leads.
    expect(a.text).toContain("RETAKE (strong): intimacy");
    expect(a.text.indexOf("ESCALATED")).toBeLessThan(a.text.indexOf("RETAKE (strong): intimacy"));
    // Budget respected at the raised escalation ceiling.
    expect(a.tokens).toBeLessThanOrEqual(AMENDMENTS_ESCALATED_TOKEN_MAX);
  });

  it("escalates at exactly PUNCH_THROUGH_TURNS, not one short", () => {
    const atThreshold = renderAmendments({
      sakkanNotes: [
        { axis: "darkness", active: 9, observed: 3, since_turn: NOW - PUNCH_THROUGH_TURNS },
      ],
      freshMarks: [],
      currentTurn: NOW,
      lastSampleTurn: NOW - 1,
    });
    expect(atThreshold.text).toContain("ESCALATED");

    const oneShort = renderAmendments({
      sakkanNotes: [
        { axis: "darkness", active: 9, observed: 3, since_turn: NOW - PUNCH_THROUGH_TURNS + 1 },
      ],
      freshMarks: [],
      currentTurn: NOW,
      lastSampleTurn: NOW - 1,
    });
    expect(oneShort.text).not.toContain("ESCALATED");
    expect(oneShort.text).toContain("RETAKE (strong): darkness");
  });

  it("does not escalate without a re-measurement after the note (measured, not vibed)", () => {
    // Persistence alone is not evidence: the last sample PRE-dates the note,
    // so the gauge has never re-read the axis since the correction fired.
    const unmeasured = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 3, since_turn: NOW - 5 }],
      freshMarks: [],
      currentTurn: NOW,
      lastSampleTurn: NOW - 6,
    });
    expect(unmeasured.text).not.toContain("ESCALATED");
    expect(unmeasured.text).toContain("RETAKE (strong): darkness");

    // No lastSampleTurn at all -> never escalate.
    const noSample = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 3, since_turn: NOW - 5 }],
      freshMarks: [],
      currentTurn: NOW,
    });
    expect(noSample.text).not.toContain("ESCALATED");
  });

  it("does not escalate a note back in band, nor without a current turn", () => {
    // Old but closed (|Δ|=1, inside the band): a plain retake at most, never escalated.
    const closed = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 8, since_turn: 1 }],
      freshMarks: [],
      currentTurn: NOW,
      lastSampleTurn: NOW - 1,
    });
    expect(closed.text).not.toContain("ESCALATED");
    expect(closed.tokens).toBeLessThanOrEqual(AMENDMENTS_TOKEN_MAX);

    // No currentTurn → nothing can be aged → no escalation (the plain channel).
    const noTurn = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 3, since_turn: 1 }],
      freshMarks: [],
    });
    expect(noTurn.text).not.toContain("ESCALATED");
    expect(noTurn.text).toContain("RETAKE (strong): darkness");
  });
});
