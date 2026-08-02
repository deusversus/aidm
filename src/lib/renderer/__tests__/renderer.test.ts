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
    expect(settei.charterOverTarget).toBe(false);
  });

  it("the overrun flag reports the measurement, never a guess (M3 C1)", () => {
    // Live campaigns run ~2× the §4.4a ceiling and the overrun was recorded
    // only as a trim string nobody reads. The flag must track the number it
    // claims to describe, on every contract the renderer can be handed.
    for (const s of [
      renderSettei({ contract: bebopContract(), marks: [] }),
      // A contract carrying extra Block-1 freight — laws, a control key, and
      // standing calibration — is where the ladder actually runs out of rope.
      renderSettei({
        contract: bebopContract({
          premise_laws: Array.from({ length: 6 }, (_, i) => `Law ${i}: ${"x".repeat(200)}`),
        }),
        marks: [],
      }),
    ]) {
      expect(s.charterOverTarget).toBe(s.charterTokens > SETTEI_TOKEN_TARGET.max);
      // An over-budget charter always says so in its trims as well.
      if (s.charterOverTarget) {
        expect(s.trims.some((t) => t.includes("still over budget"))).toBe(true);
      }
    }
  });

  it("picks exemplars for the most extreme covered axes at the matching band", () => {
    // Bebop's fixture carries an example_voice, so the author's hand takes one
    // of §4.4a's three slots and foreign passages cap at 2 (M2R4).
    expect(settei.exemplarIds[0]).toBe("moral_complexity_b9_vinland");
    expect(settei.exemplarIds.length).toBeLessThanOrEqual(2);
    // A second foreign passage rides only if the budget holds it; Bebop's
    // charter is dense enough that it does not.
    if (settei.exemplarIds.length === 2) {
      expect(settei.exemplarIds[1]).toBe("empathy_b9_fruitsbasket");
    } else {
      expect(settei.trims.some((t) => t.startsWith("exemplar "))).toBe(true);
    }
  });

  it("picks up to three foreign passages when the premise carries no author sample", () => {
    const contract = bebopContract();
    contract.active.voice.author_voice.example_voice = "";
    const s = renderSettei({ contract, marks: [] });
    expect(s.text).not.toContain("THIS AUTHOR'S OWN HAND");
    expect(s.exemplarIds[0]).toBe("moral_complexity_b9_vinland");
    expect(s.exemplarIds[1]).toBe("empathy_b9_fruitsbasket");
    // Legacy behavior: the third slot is a foreign passage, and the trim floor
    // is 2 — never 1.
    expect(s.exemplarIds.length).toBeGreaterThanOrEqual(2);
    if (s.exemplarIds.length === 3) expect(s.exemplarIds[2]).toBe("continuity_b1_kino");
    expect(s.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);
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

describe("the author's hand leads the exemplars (§4.4a, M2R4)", () => {
  const HAND =
    "(THIS AUTHOR'S OWN HAND, verbatim — when the passages below and this hand disagree, this hand wins)";
  // A Re:ZERO-shaped example_voice: a full in-register paragraph, not a tagline
  // — the case the deliverable exists for, and the one that maxes the charter.
  const LONG_SAMPLE = [
    "The cold came first, the way it always did, crawling up from the cobblestones into the",
    "soles of his shoes, and Subaru understood — before the pain, before the sound of his own",
    "name in someone else's mouth — that he had already lost this one. Again. The market was",
    "loud. The market was always loud. Somewhere behind him a woman was laughing at a joke he",
    "would never hear the end of, and he thought, with the awful clarity of a man who has done",
    "this too many times: I know how she dies. I know the hour. I know I will not be enough,",
    "and I am going to try anyway, because the alternative is to stand here in the cold and let",
    "the clock run out on someone who still believes I am the kind of person who saves people.",
  ].join(" ");

  it("renders the sample first in the exemplar section, framed as senior to the strangers", () => {
    const s = renderSettei({ contract: bebopContract(), marks: [] });
    const handAt = s.text.indexOf(HAND);
    expect(handAt).toBeGreaterThan(-1);
    // Inside the exemplar section, and ahead of every foreign passage.
    expect(handAt).toBeGreaterThan(s.text.indexOf("## Register exemplars"));
    expect(handAt).toBeLessThan(s.text.indexOf("(moral_complexity at the"));
    // The sample follows its framing line immediately.
    expect(s.text.slice(handAt)).toContain(`${HAND}\nWhatever happens, happens.`);
  });

  it("renders the sample ONCE — the fingerprint block no longer repeats it", () => {
    const s = renderSettei({ contract: bebopContract(), marks: [] });
    expect(s.text).not.toContain("In-register sample:");
    expect(s.text).toContain("## Voice fingerprint (verbatim)");
    expect(s.text).toContain("deflection as intimacy");
  });

  it("is NEVER trimmed on a maxed charter — the foreign passages pay instead", () => {
    const contract = bebopContract();
    contract.active.voice.author_voice.example_voice = LONG_SAMPLE;
    const s = renderSettei({
      contract,
      marks: [],
      // Taste notes ride too, so every rung of the ladder is live.
      tasteNotes: ["loves quiet aftermath scenes"],
    });
    // The charter is genuinely at the ceiling here (the ladder fires in full).
    expect(s.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);
    expect(s.charterTokens).toBeGreaterThan(SETTEI_TOKEN_TARGET.max - 60);
    expect(s.trims.length).toBeGreaterThan(0);
    // Everything else gave: taste, a foreign exemplar, craft caveats.
    expect(s.trims.some((t) => t.startsWith("taste note dropped"))).toBe(true);
    expect(s.trims.some((t) => t.startsWith("exemplar "))).toBe(true);
    // The author's hand survives, whole and in place.
    expect(s.text).toContain(HAND);
    expect(s.text).toContain(LONG_SAMPLE);
    expect(s.trims.some((t) => t.includes("author"))).toBe(false);
    // Floor drops to ONE foreign passage when the sample renders: sample +
    // one stranger still meets §4.4a's "2–3 exemplars".
    expect(s.exemplarIds).toHaveLength(1);
  });

  it("caps foreign exemplars at 2 alongside the sample — the cap binds, not the budget", () => {
    // A deliberately light charter with THREE covered extremes and room to
    // spare: whatever limits the foreign passages here is the cap, not a trim.
    const lean = (sample: string) => {
      const c = bebopContract();
      for (const axis of Object.keys(c.active.treatment) as AxisName[]) {
        c.active.treatment[axis] = 5;
      }
      c.active.treatment.darkness = 9;
      c.active.treatment.comedy = 9;
      c.active.treatment.intimacy = 9;
      c.active.voice.director_personality = "Terse.";
      c.active.voice.cast_depth_posture = {
        main_cast: "deep",
        supporting: "sharp",
        recurring_bits: "brief",
      };
      c.active.voice.author_voice.example_voice = sample;
      c.spark = "one moment";
      return c;
    };

    const withSample = renderSettei({ contract: lean("Whatever happens, happens."), marks: [] });
    expect(withSample.text).toContain(HAND);
    expect(withSample.exemplarIds).toEqual(["darkness_b9_berserk", "comedy_b9_konosuba"]);
    // The third candidate was never picked, and nothing was trimmed to get here.
    expect(withSample.trims).toHaveLength(0);
    expect(withSample.text).not.toContain("(intimacy at the");
    expect(withSample.charterTokens).toBeLessThanOrEqual(SETTEI_TOKEN_TARGET.max);

    // Same charter without the author sample: the third slot goes to a foreign
    // passage — it is picked, and only then does the budget rule on it.
    const noSample = renderSettei({ contract: lean(""), marks: [] });
    expect(noSample.trims).toContain("exemplar intimacy_b9_march dropped for budget");
  });

  it("drops the seniority clause when no foreign passage follows (no pointing at ghosts)", () => {
    // All-mid treatment: no covered extremes, so zero foreign exemplars — the
    // sample still leads the section, framed as the anchor, not as senior to
    // passages that aren't there.
    const c = bebopContract();
    for (const axis of Object.keys(c.active.treatment) as AxisName[]) {
      c.active.treatment[axis] = 5;
    }
    const s = renderSettei({ contract: c, marks: [] });
    expect(s.exemplarIds).toHaveLength(0);
    expect(s.text).toContain("(THIS AUTHOR'S OWN HAND, verbatim — the register's anchor)");
    expect(s.text).not.toContain("this hand wins");
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

describe("the law channel in the Settei (M2R6 — obeyed text, never scored text)", () => {
  const lawed = () =>
    bebopContract({
      premise_laws: [
        "There is no cost to my power and no loss of control.",
        "tension_source: collateral consequence — who pays the cost when he wins",
      ],
    });

  it("renders the player's clauses verbatim in the world-rules command block", () => {
    const s = renderSettei({ contract: lawed(), marks: [] });
    expect(s.text).toContain("Premise law (the player's word");
    expect(s.text).toContain("There is no cost to my power and no loss of control.");
    expect(s.text).toContain("collateral consequence");
    // The absence clause is fenced explicitly: the register fills unfenced
    // hollows with genre, and a substitute price is the fill this forbids.
    expect(s.text).toContain("do not fill the space");
    // Hard core, ahead of the charter's advisory pressure (axiom 3).
    expect(s.text.indexOf("Premise law")).toBeLessThan(s.text.indexOf("## What this story is"));
  });

  it("renders NOTHING when no law was carved", () => {
    const s = renderSettei({ contract: bebopContract(), marks: [] });
    expect(s.text).not.toContain("Premise law");
  });

  it("is Block-1 freight, never charter budget (the control-key precedent)", () => {
    const lawless = renderSettei({ contract: bebopContract(), marks: [] });
    const withLaw = renderSettei({ contract: lawed(), marks: [] });
    expect(withLaw.charterTokens).toBe(lawless.charterTokens);
    expect(withLaw.tokens).toBeGreaterThan(lawless.tokens);
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

describe("the Director's ear in the Amendments (voice, M2R4)", () => {
  const VOICE_HEADER =
    "## The Director's ear (voice — the author's hand, kept; this restates the standing charter's fingerprint, it does not override it)";

  it("renders the measured pressure line first, then the Director's patterns", () => {
    const a = renderAmendments({
      sakkanNotes: [],
      freshMarks: [],
      voicePressure:
        "Voice is thinning: dialogue quirks read 4/10 — the deflection-as-intimacy beat has gone missing.",
      voicePatterns: ["cold opens on an object, not a face", "the joke lands a beat late"],
    });
    expect(a.text).toContain(VOICE_HEADER);
    expect(a.text.indexOf("Voice is thinning")).toBeGreaterThan(a.text.indexOf(VOICE_HEADER));
    expect(a.text.indexOf("Voice is thinning")).toBeLessThan(a.text.indexOf("- cold opens"));
    expect(a.text).toContain("- the joke lands a beat late");
    expect(a.tokens).toBeLessThanOrEqual(AMENDMENTS_TOKEN_MAX);
  });

  it("caps the patterns at three and renders either half alone", () => {
    const capped = renderAmendments({
      sakkanNotes: [],
      freshMarks: [],
      voicePatterns: ["one", "two", "three", "four"],
    });
    expect(capped.text).toContain("- three");
    expect(capped.text).not.toContain("- four");

    const pressureOnly = renderAmendments({
      sakkanNotes: [],
      freshMarks: [],
      voicePressure: "emotional rhythm is running flat",
    });
    expect(pressureOnly.text).toContain(VOICE_HEADER);
    expect(pressureOnly.text).toContain("emotional rhythm is running flat");
  });

  it("renders no section when neither the Sakkan nor the Director has anything", () => {
    const a = renderAmendments({ sakkanNotes: [], freshMarks: [], voicePatterns: [] });
    expect(a.text).toBe("");
    const b = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 6, since_turn: 4 }],
      freshMarks: [],
    });
    expect(b.text).not.toContain("Director's ear");
  });

  it("sits beside the Amendments block without displacing it", () => {
    const a = renderAmendments({
      sakkanNotes: [{ axis: "darkness", active: 9, observed: 6, since_turn: 4 }],
      freshMarks: [mark("register", "keep it plainer")],
      voicePatterns: ["cold opens on an object, not a face"],
    });
    expect(a.text.indexOf("## Amendments (this scene)")).toBe(0);
    expect(a.text.indexOf(VOICE_HEADER)).toBeGreaterThan(a.text.indexOf("keep it plainer"));
  });

  it("yields FIRST under budget pressure — patterns one at a time, then the section", () => {
    const longPattern = (n: number) =>
      `pattern ${n}: the narration keeps reaching for a simile where the author would have used a hard noun and stopped`;
    const freshMarks = Array.from({ length: 7 }, (_, i) =>
      mark(`topic_${i}`, `a calibration direction about restraint number ${i}`),
    );
    const notes = [
      { axis: "darkness" as const, active: 9, observed: 3, since_turn: 4 },
      { axis: "comedy" as const, active: 1, observed: 6, since_turn: 5 },
    ];

    // Enough voice content that the section alone would blow the budget.
    const squeezed = renderAmendments({
      sakkanNotes: notes,
      freshMarks,
      voicePressure:
        "Voice is thinning: dialogue quirks read 3/10 across the last sample — the deflection-as-intimacy beat is gone and the lines are saying what they mean.",
      voicePatterns: [longPattern(1), longPattern(2), longPattern(3)],
    });
    expect(squeezed.tokens).toBeLessThanOrEqual(AMENDMENTS_TOKEN_MAX);
    expect(squeezed.trims.some((t) => t.startsWith("voice pattern dropped"))).toBe(true);
    // Everything the voice section outranked is still on the page: the whole
    // voice section goes before a single fresh mark does.
    expect(squeezed.text).toContain("RETAKE (strong): darkness");
    expect(squeezed.text).toContain("RETAKE (strong): comedy");
    expect(squeezed.text).toContain("restraint number 6");
    expect(squeezed.trims.some((t) => t.startsWith("dropped for budget"))).toBe(false);
    // Under this much pressure the section itself is gone, measured line included.
    expect(squeezed.trims).toContain("voice section dropped for budget");
    expect(squeezed.text).not.toContain("Director's ear");
    expect(squeezed.text).not.toContain("Voice is thinning");
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
    // Premise pressure intact: the author's hand plus a foreign passage — the
    // exemplar floor with a sample rendering (M2R4).
    expect(settei.text).toContain("THIS AUTHOR'S OWN HAND");
    expect(settei.exemplarIds.length).toBeGreaterThanOrEqual(1);
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
