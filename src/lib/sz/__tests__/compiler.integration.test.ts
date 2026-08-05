import * as schema from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { renderSettei } from "@/lib/renderer/settei";
import { NarrativeFocus, TensionSource } from "@/lib/types/composition";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compileSessionZero,
  dedupeAdmissions,
  gapVerdict,
  normalizeFramingValue,
  resolveObservations,
} from "../compiler";
import type { ConductorDraft, Observation } from "../conductor";

/** Real-DB compile: scripted draft → contract + OSP → persisted handoff. */

// The OSP synthesizer is injected per test; the ONE remaining live model call
// in the compiler is M3R3 C4a's voice transposition, mocked at this seam.
vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});
const mockJudgment = vi.mocked(callJudgment);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sz.compiler] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const obs = (kind: Observation["kind"], content: string): Observation => ({
  kind,
  content,
  confidence: 0.9,
});

// The dedup rules are pure — exercised without a DB so they run everywhere.
describe("dedupeAdmissions (§6.5 identity guard, deterministic)", () => {
  it("folds self-insert protagonist briefs into ONE npc, identity before capability", () => {
    // Today's real defect: the OSP minted the self-insert twice, under two
    // placeholder names, from a backstory brief and a capabilities brief.
    const out = dedupeAdmissions([
      {
        name: "The Protagonist (unnamed)",
        kind: "cast",
        brief: "Raised in the lower wards; carries a dead mentor's compass.",
      },
      {
        name: "player's protagonist",
        kind: "cast",
        brief: "A duelist whose ability channels stormlight into a blade.",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.entityType).toBe("npc");
    expect(out[0]?.name).toBe("The Protagonist");
    expect(out[0]?.block).toContain("lower wards");
    expect(out[0]?.block).toContain("stormlight");
    // Identity material precedes capability material in the merged block.
    expect(out[0]?.block.indexOf("lower wards")).toBeLessThan(
      out[0]?.block.indexOf("stormlight") ?? -1,
    );
  });

  it("keeps a real extracted name when the description flags the self-insert", () => {
    const out = dedupeAdmissions([
      { name: "Kaelen", kind: "cast", brief: "The player's protagonist; a wandering smith." },
      { name: "protagonist", kind: "cast", brief: "Fights with an ability drawn from grief." },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Kaelen");
  });

  it("merges near-duplicate names of the same type; leaves distinct entities alone", () => {
    const out = dedupeAdmissions([
      { name: "The Trawler", kind: "world", brief: "A converted fishing boat." },
      { name: "the trawler.", kind: "world", brief: "Its hold smells of brine and fuel." },
      { name: "Ganymede Dock", kind: "world", brief: "A closing-time berth." },
    ]);
    expect(out).toHaveLength(2);
    const trawler = out.find((e) => e.name === "The Trawler");
    expect(trawler?.block).toContain("fishing boat");
    expect(trawler?.block).toContain("brine");
  });

  it("does NOT merge DIFFERENT names for the same meaning (M2 alias territory)", () => {
    const out = dedupeAdmissions([
      { name: "Lloyd and protagonist connection", kind: "thread", brief: "Their paths tangle." },
      { name: "Path-Crossing with Lloyd", kind: "thread", brief: "Lloyd keeps reappearing." },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not mistake a non-protagonist NPC for the self-insert", () => {
    const out = dedupeAdmissions([
      { name: "Lloyd", kind: "cast", brief: "The protagonist's rival and foil." },
      { name: "The Protagonist", kind: "cast", brief: "The player's self-insert lead." },
    ]);
    expect(out).toHaveLength(2);
    expect(out.some((e) => e.name === "Lloyd")).toBe(true);
    expect(out.some((e) => e.name === "The Protagonist")).toBe(true);
  });
});

const SCRIPTED_OBSERVATIONS: Observation[] = [
  obs(
    "spark",
    "The moment someone says 'whatever happens, happens' and walks toward the thing anyway.",
  ),
  obs("finitude", "finite — they want the story to trend toward an end"),
  // M2 C4: the protagonist is NAMED — the gap verdict blocks an unnamed,
  // un-deferred PC. A real name in the shared fixture; the dedup fixture below
  // overrides it with the deferral form to prove that path also compiles.
  obs("pc_name", "Jules — the player's own bounty hunter, named after the source"),
  // SV2: the concept gate blocks a conceptless, un-deferred table — the shared
  // fixture carries one (seat + big idea, verbatim).
  obs(
    "pc_concept",
    "Someone new beside the canon crew — a washed-up bounty hunter who can't stop paying other people's debts",
  ),
  obs("death_physics", "death is real, sudden, and cheap; nobody gets a speech"),
  obs("lethality_posture", "a little more intense than default; losses stay lost"),
  obs("hard_line", "no harm to children on-screen"),
  obs("calibration", '{"axis": "darkness", "value": 8}'),
  obs(
    "canonicality",
    '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "full_cast", "event_fidelity": "influenceable"}',
  ),
  obs("presentation", "bare prose; episode-title cards only"),
  obs("presentation_directive", '{"name": "readout", "skin": "the bounty terminal"}'),
  obs("suggestion_affordance", "on_request_only"),
  obs(
    "tier_selection",
    '{"narration": "claude-sonnet-5", "judgment": "claude-haiku-4-5", "probe": "claude-haiku-4-5"}',
  ),
  obs("world_fact", "The crew operates out of a converted fishing trawler, not the canon ship"),
  obs("player_taste", "loves found-family premises; plays late at night"),
  obs("deferred", "who the recurring antagonist is — director's territory"),
];

const STUB_OSP = {
  director_inputs: {
    opening_situation: "A bounty gone quiet on a Ganymede dock at closing time.",
    spark_reading: "Fatalism worn as freedom; walking toward the thing anyway.",
    suggested_first_arc_question: "What does the crew owe each other when the money's gone?",
  },
  animation_inputs: {
    forbidden_opening_moves: ["revealing the antagonist", "spending the spark in scene one"],
    opening_pov: "the player's character, mid-shift, before the trouble",
  },
  constraints: [
    { text: "no harm to children on-screen", tier: "hard" as const },
    { text: "keep episodes bounty-shaped early", tier: "soft" as const },
  ],
  uncertainties: [
    {
      question: "who the recurring antagonist is",
      safe_assumption: "someone inside the bounty system itself",
      degraded_generation_guidance: "keep antagonist references faceless and institutional",
    },
  ],
  briefs: [
    {
      name: "The Trawler",
      kind: "world" as const,
      brief: "A converted fishing trawler serving as the crew's ship.",
      admit_to_catalog: true,
    },
  ],
  orphan_facts: ["the player hums the OP when happy"],
};

// --- M3R3 C4a fixtures: an anchor that actually CARRIES voice matter --------
// The defect this commit kills needs cards to leak; the shared stub profile has
// none, so the canonicality suite gets its own anchor.

const ANCHOR_AUTHOR_VOICE = {
  sentence_patterns: ["clipped, jazz-phrased"],
  structural_motifs: ["cold open", "smash cut to quiet"],
  dialogue_quirks: ["deflection as intimacy"],
  emotional_rhythm: ["long cool, sudden ache"],
  example_voice: "Whatever happens, happens.",
};

const ANCHOR_DIRECTOR =
  "A jazz musician directing a noir film: improvises, digresses, and always lands the final note a beat after you expect it.";

const ANCHOR_CARDS = [
  {
    name: "Spike Spiegel",
    speech_patterns: "Lazy drawl that sharpens without warning.",
    humor_type: "Sardonic" as const,
    signature_phrases: ["Whatever happens, happens."],
    dialogue_rhythm: "Slouched half-sentences, then one clean line.",
    emotional_expression: "Deflecting" as const,
  },
  {
    name: "Faye Valentine",
    speech_patterns: "Brash, transactional, guarded under the volume.",
    humor_type: "Sardonic" as const,
    signature_phrases: ["You're gonna carry that weight."],
    dialogue_rhythm: "Fast, overlapping, allergic to a pause.",
    emotional_expression: "Explosive" as const,
  },
];

/** The transposed voice the mocked judgment returns — no source nouns in it. */
const TRANSPOSED = {
  author_voice: {
    sentence_patterns: ["clipped, jazz-phrased"],
    structural_motifs: ["cold open", "smash cut to quiet"],
    dialogue_quirks: ["deflection as intimacy"],
    emotional_rhythm: ["long cool, sudden ache"],
    example_voice: "The trawler's hold smells of brine. Nobody says the name out loud.",
  },
  director_personality:
    "Direct the debt and the dock, not the legend: let the crew talk around what they owe until the silence does the work.",
};

/** Arm the ONE live compiler call; anything else named is a test bug. */
function armTransposition(impl: () => unknown): void {
  mockJudgment.mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic judgment signature
    (_s: any, o: any) => {
      if (o.name !== "compile_voice_transposition") {
        throw new Error(`unexpected judgment call in the compiler: ${o.name}`);
      }
      return Promise.resolve(impl()) as never;
    },
  );
}

// --- M3R3 C4b fixtures: the true-original path -------------------------------
// v3's structural escape from voice leakage was generate_custom_profile — a
// world built with NO voice_cards key at all. These fixtures stand in for the
// two judged calls that rebuild it from the player's stated vision.

/** Call (a): the gauges. Bebop's shape with two axes MOVED, so a synthesized
 *  canonical value is distinguishable from the anchored fixtures'. */
const ORIGINAL_GAUGE = {
  treatment: { ...bebopContract().canonical.treatment, darkness: 3 },
  framing: { ...bebopContract().canonical.framing, narrative_focus: "party" as const },
};

/** Call (b): v3's creative fields in v5's shapes — a world nobody researched. */
const ORIGINAL_WORLD = {
  world_name: "The Kettle Reach",
  director_personality:
    "Direct the Reach like a debt coming due: let the tide keep better books than the men who own it, and never let a favor be free.",
  author_voice: {
    sentence_patterns: ["short lines, then one long one that spends the whole breath"],
    structural_motifs: ["open on the ledger, close on the weather"],
    dialogue_quirks: ["nobody names the debt out loud"],
    emotional_rhythm: ["patience, then one cracked note"],
    example_voice: "The tide came back for the Reach before the collectors did.",
  },
  visual_style: {
    art_style: "salt-bleached ink over watercolor",
    color_palette: "brine green and lamp-oil amber",
    reference_descriptors: ["low horizons", "rope and rust"],
  },
  world_setting: {
    genre: ["maritime fantasy", "crime"],
    locations: ["The Kettle", "Lowwater Market"],
    factions: ["the Ledgermen", "the Tide Choir"],
  },
  combat_style: "tactical" as const,
  power_distribution: {
    peak_tier: "T5" as const,
    typical_tier: "T8" as const,
    floor_tier: "T10" as const,
    gradient: "flat" as const,
  },
  stat_mapping_has_stats: false,
  stat_system_name: "",
};

/** Arm C4b's synthesis pair. A transposition call on this path is the defect
 *  the guard exists to prevent, so it throws like any unexpected name. */
function armOriginalSynthesis(opts: { failWorldCall?: boolean } = {}): void {
  mockJudgment.mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic judgment signature
    (_s: any, o: any) => {
      if (o.name === "compile_original_treatment") {
        return Promise.resolve(ORIGINAL_GAUGE) as never;
      }
      if (o.name === "compile_original_world") {
        return (
          opts.failWorldCall
            ? Promise.reject(new Error("original world synthesis boom"))
            : Promise.resolve(ORIGINAL_WORLD)
        ) as never;
      }
      throw new Error(`unexpected judgment call in the compiler: ${o.name}`);
    },
  );
}

describe("suggestion affordance resolution (anchored, never guessed from prose)", () => {
  it("does not read prose 'never' as the value (live misparse 2026-07-10)", () => {
    const r = resolveObservations([
      obs(
        "suggestion_affordance",
        "Yes to suggested moves at decision points, but diegetically wrapped as the protagonist's own system — never as a fourth-wall voice.",
      ),
    ]);
    expect(r.suggestionAffordance).toBe("on_request_only");
    expect(r.parseFailures.some((d) => d.includes("ambiguous suggestion affordance"))).toBe(true);
  });

  it("anchored 'never' resolves", () => {
    const r = resolveObservations([obs("suggestion_affordance", "never — player declined chips")]);
    expect(r.suggestionAffordance).toBe("never");
  });

  it("snake_case token resolves unanchored", () => {
    const r = resolveObservations([
      obs("suggestion_affordance", "player chose default_on, wrapped diegetically"),
    ]);
    expect(r.suggestionAffordance).toBe("default_on");
  });
});

describe("control key declination (§7.5 — no key exists unless the player cuts one)", () => {
  it("an anchored decline compiles to NO key — never a cut key wearing a refusal", () => {
    const r = resolveObservations([
      obs("control_key", "Declined — no loss-of-control mechanic; the power stays fully his own"),
    ]);
    expect(r.controlKey).toBeUndefined();
  });

  it("decline-then-cut: the later cut stands (latest wins)", () => {
    const r = resolveObservations([
      obs("control_key", "declined — wants no leash"),
      obs("control_key", "when the bloodrage takes hold after a bondmate falls"),
    ]);
    expect(r.controlKey).toBe("when the bloodrage takes hold after a bondmate falls");
  });

  it("cut-then-decline: the later decline melts the key", () => {
    const r = resolveObservations([
      obs("control_key", "when the seal cracks under a full moon"),
      obs("control_key", "Declined after reflection — no loss-of-control stakes after all"),
    ]);
    expect(r.controlKey).toBeUndefined();
  });

  it("a real key CONTAINING 'declined' mid-sentence stays a key (the anchor is the guard)", () => {
    const cut = "when he has declined every warning and the beast takes him";
    const r = resolveObservations([obs("control_key", cut)]);
    expect(r.controlKey).toBe(cut);
  });

  it("a quoted decline still resolves as a decline", () => {
    const r = resolveObservations([obs("control_key", '"declined" — keep the power leashless')]);
    expect(r.controlKey).toBeUndefined();
  });
});

describe("protagonist name resolution + gap (M2 C4, deterministic)", () => {
  it("gap verdict blocks an unnamed, un-deferred protagonist", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name")),
      true,
    );
    expect(gaps.some((g) => g.includes("protagonist is unnamed"))).toBe(true);
  });

  it("resolves anchored-first: 'Kaelen — he chose it himself' → 'Kaelen'", () => {
    const r = resolveObservations([obs("pc_name", "Kaelen — he chose it himself")]);
    expect(r.pcName).toBe("Kaelen");
    expect(r.pcNameDeferred).toBe(false);
  });

  it("honorific-led names survive the sentence-period cut (audit #2)", () => {
    expect(resolveObservations([obs("pc_name", "Dr. Elara Voss — the title matters")]).pcName).toBe(
      "Dr. Elara Voss",
    );
    expect(resolveObservations([obs("pc_name", "Lt. Col. Roy Mustang")]).pcName).toBe(
      "Lt. Col. Roy Mustang",
    );
    expect(resolveObservations([obs("pc_name", "Kaelen. He chose it himself.")]).pcName).toBe(
      "Kaelen",
    );
    expect(resolveObservations([obs("pc_name", "Ka'el")]).pcName).toBe("Ka'el");
  });

  it("an explicit deferral overrides an OSP-invented brief name (audit #1)", () => {
    const out = dedupeAdmissions(
      [
        {
          name: "Kaelen",
          kind: "cast",
          brief: "The player's self-insert; a name the OSP invented despite the deferral.",
        },
      ],
      undefined,
      { nameDeferred: true },
    );
    const pc = out.find((a) => a.isPlayerProtagonist);
    expect(pc?.name).toBe("The Protagonist");
  });

  it("the deferral form defers and records a note", () => {
    const r = resolveObservations([
      obs("pc_name", "deferred — the player wants it to emerge in play"),
    ]);
    expect(r.pcName).toBeUndefined();
    expect(r.pcNameDeferred).toBe(true);
    expect(r.playerDeferred.some((d) => d.includes("protagonist name deferred"))).toBe(true);
  });

  it("latest wins on a rename, and a later real name clears an earlier deferral", () => {
    const renamed = resolveObservations([
      obs("pc_name", "Kaelen"),
      obs("pc_name", "Seryn — she renamed the character mid-conversation"),
    ]);
    expect(renamed.pcName).toBe("Seryn");
    expect(renamed.pcNameDeferred).toBe(false);

    const undeferred = resolveObservations([
      obs("pc_name", "deferred — undecided for now"),
      obs("pc_name", "Kaelen"),
    ]);
    expect(undeferred.pcName).toBe("Kaelen");
    expect(undeferred.pcNameDeferred).toBe(false);
    // SV2: the resolved deferral leaves no stale open item behind — the
    // summary must never claim the name is being left open when it isn't.
    expect(undeferred.playerDeferred.some((d) => d.includes("protagonist name deferred"))).toBe(
      false,
    );
  });
});

describe("character concept resolution + gap (SV2, deterministic)", () => {
  it("gap verdict blocks a conceptless, un-deferred table", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_concept")),
      true,
    );
    expect(gaps.some((g) => g.includes("concept was never gathered"))).toBe(true);
  });

  it("resolves VERBATIM, latest-wins — never parsed, never truncated", () => {
    const concept =
      "Replace the protagonist: the Straw Hats exist, but the captain's seat is mine. A cook who fights only to feed people.";
    const r = resolveObservations([
      obs("pc_concept", "someone new beside the cast — an early draft"),
      obs("pc_concept", concept),
    ]);
    expect(r.pcConcept).toBe(concept);
    expect(r.pcConceptDeferred).toBe(false);
    // The canon-seat choice rides the concept AND its canonicality
    // observation — both resolve from the same exchange.
    const seat = resolveObservations([
      obs("pc_concept", concept),
      obs(
        "canonicality",
        '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "replaced_protagonist"}',
      ),
    ]);
    expect(seat.canonicality?.canon_cast_mode).toBe("replaced_protagonist");
  });

  it("the deferral form defers, notes it, and passes the gate", () => {
    const r = resolveObservations([
      ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_concept"),
      obs("pc_concept", "deferred — the player wants the character to emerge in play"),
    ]);
    expect(r.pcConcept).toBeUndefined();
    expect(r.pcConceptDeferred).toBe(true);
    expect(r.playerDeferred.some((d) => d.includes("character concept deferred"))).toBe(true);
    expect(gapVerdict(r, true).some((g) => g.includes("concept"))).toBe(false);
  });

  it("a later concrete concept clears an earlier deferral AND its note", () => {
    const r = resolveObservations([
      obs("pc_concept", "deferred — not sure yet"),
      obs("pc_concept", "A talentless underdog who trains harder than anyone"),
    ]);
    expect(r.pcConcept).toContain("underdog");
    expect(r.pcConceptDeferred).toBe(false);
    expect(r.playerDeferred.some((d) => d.includes("character concept deferred"))).toBe(false);
  });

  it("mid-string 'deferred' in verbatim prose is NOT a deferral (the sentinel is anchored)", () => {
    // The concept is free prose — the player's own words may contain the
    // sentinel word. Only a LEADING "deferred" is the player's deferral.
    const prose = "a knight whose dream was deferred until now";
    const r = resolveObservations([obs("pc_concept", prose)]);
    expect(r.pcConcept).toBe(prose);
    expect(r.pcConceptDeferred).toBe(false);
    // Same discipline on the name path (C4 family).
    const named = resolveObservations([
      obs("pc_name", "Kaelen — he deferred the choice for years"),
    ]);
    expect(named.pcName).toBe("Kaelen");
    expect(named.pcNameDeferred).toBe(false);
  });

  it("a curly-single-quoted deferral still defers (the anchor knows every quote form)", () => {
    // Models quote-wrap despite anchoring instructions; the quote-strip on the
    // name path already anticipates ‘…’ — the deferral anchor must too.
    const r = resolveObservations([obs("pc_concept", "‘deferred — let the character emerge’")]);
    expect(r.pcConcept).toBeUndefined();
    expect(r.pcConceptDeferred).toBe(true);
    const name = resolveObservations([obs("pc_name", "‘deferred — no name yet’")]);
    expect(name.pcName).toBeUndefined();
    expect(name.pcNameDeferred).toBe(true);
  });
});

describe("power tier + framing choices (SV3, deterministic)", () => {
  it("power tier resolves with its baseline, latest-wins; malformed and off-ladder defer", () => {
    const r = resolveObservations([
      obs("pc_power_tier", '{"tier": "T7", "baseline": "T8"}'),
      obs("pc_power_tier", '{"tier": "T5", "baseline": "T8"}'),
    ]);
    expect(r.pcPowerTier).toBe("T5");
    expect(r.pcPowerBaseline).toBe("T8");

    const prose = resolveObservations([obs("pc_power_tier", "far above baseline, T3-ish")]);
    expect(prose.pcPowerTier).toBeUndefined();
    expect(prose.parseFailures.some((d) => d.includes("unparseable power tier"))).toBe(true);
    // Off the T1-T10 ladder never lands a garbage tier on the contract.
    const off = resolveObservations([obs("pc_power_tier", '{"tier": "T11", "baseline": "T8"}')]);
    expect(off.pcPowerTier).toBeUndefined();
    expect(off.parseFailures.some((d) => d.includes("unparseable power tier"))).toBe(true);
    // A later valid record clears the stale note — the recap must not send the
    // conductor re-asking a question the table already settled (M2R6).
    const repaired = resolveObservations([
      obs("pc_power_tier", "far above baseline, T3-ish"),
      obs("pc_power_tier", '{"tier": "T3", "baseline": "T8"}'),
    ]);
    expect(repaired.pcPowerTier).toBe("T3");
    expect(repaired.parseFailures).toHaveLength(0);
  });

  it("framing choices validate per-axis and win latest; nothing unplaceable is dropped", () => {
    const r = resolveObservations([
      obs("framing_choice", '{"axis": "tension_source", "value": "burden"}'),
      obs("framing_choice", '{"axis": "tension_source", "value": "existential"}'),
      obs("framing_choice", '{"axis": "narrative_focus", "value": "mundane"}'),
      obs("framing_choice", '{"axis": "mode", "value": "op_dominant"}'),
      // An off-enum VALUE on a real axis becomes LAW and must not clobber the
      // settled pick (M2R6 — it used to become a dead letter in `deferred`).
      obs("framing_choice", '{"axis": "tension_source", "value": "vibes"}'),
      // A coined AXIS is law too; so is a record that isn't even JSON.
      obs("framing_choice", '{"axis": "power_level", "value": "high"}'),
      obs("framing_choice", "make it feel like a legend"),
    ]);
    expect(r.framingChoices).toContainEqual({ axis: "tension_source", value: "existential" });
    expect(r.framingChoices).toContainEqual({ axis: "narrative_focus", value: "mundane" });
    expect(r.framingChoices).toContainEqual({ axis: "mode", value: "op_dominant" });
    expect(r.framingChoices).toHaveLength(3);
    expect(r.premiseLaws).toEqual([
      "tension_source: vibes",
      "power_level: high",
      "make it feel like a legend",
    ]);
    // The dead-letter class is gone: a framing_choice never lands here.
    expect(r.parseFailures).toHaveLength(0);
    expect(r.playerDeferred).toHaveLength(0);
  });
});

describe("the law channel (M2R6 — the China Shop, 35a4823d)", () => {
  // The two payloads the conductor actually recorded on 2026-07-27, verbatim.
  const GLOSSED_TOKEN =
    '{"axis": "power_expression", "value": "overwhelming — force is rarely in doubt; the question is what it costs everyone else"}';
  const OFF_ENUM =
    '{"axis": "tension_source", "value": "collateral consequence — who pays the cost when he wins"}';

  it("a glossed enum token compiles to the BARE token (the model proposed right)", () => {
    const r = resolveObservations([obs("framing_choice", GLOSSED_TOKEN)]);
    expect(r.framingChoices).toEqual([{ axis: "power_expression", value: "overwhelming" }]);
    // The gloss is not load-bearing: it never becomes a second law.
    expect(r.premiseLaws).toHaveLength(0);
    expect(r.parseFailures).toHaveLength(0);
  });

  it("an off-enum resolution is CARVED AS LAW, never dropped and never rounded to a token", () => {
    const r = resolveObservations([obs("framing_choice", OFF_ENUM)]);
    // The nearest gauge reading (`consequence`) is NOT what the player said —
    // a contains-match here would overwrite the design with an approximation.
    expect(r.framingChoices).toHaveLength(0);
    expect(r.premiseLaws).toEqual([
      "tension_source: collateral consequence — who pays the cost when he wins",
    ]);
  });

  it("a premise_law clause lands VERBATIM; a re-recorded clause is the same law", () => {
    const clause = "There is no cost to my power and no loss of control.";
    const r = resolveObservations([
      obs("premise_law", clause),
      obs("premise_law", `  ${clause}  `),
      obs("premise_law", "The cost is collateral: the world around him pays it."),
    ]);
    expect(r.premiseLaws).toEqual([
      clause,
      "The cost is collateral: the world around him pays it.",
    ]);
  });

  it("token normalization takes the HEAD only — never a contained token, never a phrase", () => {
    const focus = NarrativeFocus.options;
    expect(normalizeFramingValue(focus, "reverse ensemble")).toEqual({
      token: "reverse_ensemble",
      glossed: false,
    });
    expect(normalizeFramingValue(focus, "Ensemble.")).toEqual({
      token: "ensemble",
      glossed: false,
    });
    expect(normalizeFramingValue(focus, '"mundane" — ordinary is the goal')).toEqual({
      token: "mundane",
      glossed: true,
    });
    expect(normalizeFramingValue(focus, "an ensemble of misfits")).toBeUndefined();
    const tension = TensionSource.options;
    expect(normalizeFramingValue(tension, "burden (power exacts a toll)")).toEqual({
      token: "burden",
      glossed: true,
    });
    expect(normalizeFramingValue(tension, "collateral consequence")).toBeUndefined();
    expect(normalizeFramingValue(tension, "")).toBeUndefined();
  });

  it("a glossed compile is read back at the gate — the TABLE rules whether the gloss was design", () => {
    // The C2 audit's constructed inversion: a legal head smuggling the China
    // Shop's own semantic. The token compiles; the gloss must NOT vanish.
    const r = resolveObservations([
      obs(
        "framing_choice",
        '{"axis": "tension_source", "value": "consequence — but collateral, the world pays"}',
      ),
      obs("framing_choice", '{"axis": "power_expression", "value": "overwhelming"}'),
    ]);
    expect(r.framingChoices).toContainEqual({ axis: "tension_source", value: "consequence" });
    expect(r.compiledWithGloss).toHaveLength(1);
    expect(r.compiledWithGloss[0]).toContain("consequence");
    expect(r.compiledWithGloss[0]).toContain("but collateral, the world pays");
    // A bare token carries no gloss note — no read-back noise on clean picks.
    expect(r.compiledWithGloss[0]).not.toContain("power_expression");
  });

  it("a whitespace-only premise_law surfaces as unread — the channel's last silent drop closes", () => {
    const r = resolveObservations([obs("premise_law", "   ")]);
    expect(r.premiseLaws).toHaveLength(0);
    expect(r.parseFailures).toHaveLength(1);
    expect(r.parseFailures[0]).toContain("empty premise law");
  });

  it("stale-note clearing is order-aware for EVERY kind — later read clears, later garbage surfaces", () => {
    // A broken suggestion_affordance followed by a valid one: the note clears
    // (the old settled map covered only finitude/power-tier/tier-selection).
    const healed = resolveObservations([
      obs("suggestion_affordance", "hmm whatever you think"),
      obs("suggestion_affordance", "never — full immersion"),
    ]);
    expect(healed.suggestionAffordance).toBe("never");
    expect(healed.parseFailures).toHaveLength(0);
    // The reverse order: the garbage arrived AFTER the good record — it may
    // have been an attempted change, so it still surfaces for repair.
    const suspect = resolveObservations([
      obs("finitude", "finite — it ends"),
      obs("finitude", "actually make it sort of both?"),
    ]);
    expect(suspect.finitude).toBe("finite");
    expect(suspect.parseFailures).toHaveLength(1);
  });

  it("a BROKEN structured record is a repair signal, never a law read back as prose", () => {
    const r = resolveObservations([
      // Truncated JSON: shaped like a record, holds no readable clause.
      obs("framing_choice", '{"axis": "tension_source", "value":'),
      // A real axis with an empty value holds nothing of the player's either.
      obs("framing_choice", '{"axis": "mode", "value": "   "}'),
    ]);
    expect(r.premiseLaws).toHaveLength(0);
    expect(r.parseFailures).toHaveLength(2);
  });

  it("a plain valid enum value still compiles byte-identically (regression pin)", () => {
    const r = resolveObservations([
      obs("framing_choice", '{"axis": "tension_source", "value": "burden"}'),
      obs("framing_choice", '{"axis": "power_expression", "value": "overwhelming"}'),
    ]);
    expect(r.framingChoices).toEqual([
      { axis: "tension_source", value: "burden" },
      { axis: "power_expression", value: "overwhelming" },
    ]);
    expect(r.premiseLaws).toHaveLength(0);
    expect(r.parseFailures).toHaveLength(0);
    expect(r.playerDeferred).toHaveLength(0);
  });

  it("the three lists stay distinct: law is not a deferral, a deferral is not a parse failure", () => {
    const r = resolveObservations([
      obs("premise_law", "Nobody in this world ages."),
      obs("deferred", "who the recurring antagonist is — director's territory"),
      obs("blend", "mostly bebop I guess"),
    ]);
    expect(r.premiseLaws).toEqual(["Nobody in this world ages."]);
    expect(r.playerDeferred).toEqual(["who the recurring antagonist is — director's territory"]);
    expect(r.parseFailures.some((f) => f.includes("unparseable blend"))).toBe(true);
  });
});

describe("the original-world gate (M3R3 C4b, deterministic)", () => {
  /** Everything a table needs EXCEPT anything that counts as spoken vision. */
  const VISIONLESS = SCRIPTED_OBSERVATIONS.filter(
    (o) => o.kind !== "world_fact" && o.kind !== "calibration",
  );

  it("the anchored gate is unchanged: no profile and no original-world word is still an ERROR", () => {
    const resolved = resolveObservations(SCRIPTED_OBSERVATIONS);
    // Two-arg callers — every pre-C4b call site and pin — read byte-identically.
    expect(gapVerdict(resolved, false)).toContain("no researched profile — the World never loaded");
    expect(gapVerdict(resolved, true)).toEqual([]);
  });

  it("original world: the missing-profile gap does NOT fire on a spoken vision", () => {
    expect(gapVerdict(resolveObservations(SCRIPTED_OBSERVATIONS), false, true)).toEqual([]);
  });

  it("a vision too thin to synthesize from BLOCKS — the gate stops silent guesses, not original worlds", () => {
    const none = gapVerdict(resolveObservations(VISIONLESS), false, true);
    expect(none.some((g) => g.includes("needs its vision spoken"))).toBe(true);
    // The anchored complaint never rides along: nothing failed to load here.
    expect(none.some((g) => g.includes("no researched profile"))).toBe(false);

    // One record is still under v3's bar; a second clears it — and world facts,
    // cast facts and calibration moves all count as vision.
    const one = gapVerdict(
      resolveObservations([...VISIONLESS, obs("world_fact", "The Reach pays its debts in tide")]),
      false,
      true,
    );
    expect(one.some((g) => g.includes("needs its vision spoken"))).toBe(true);
    const two = gapVerdict(
      resolveObservations([
        ...VISIONLESS,
        obs("world_fact", "The Reach pays its debts in tide"),
        obs("cast_fact", "The Ledgermen keep the book"),
      ]),
      false,
      true,
    );
    expect(two).toEqual([]);
    const calibrated = gapVerdict(
      resolveObservations([
        ...VISIONLESS,
        obs("calibration", '{"axis": "darkness", "value": 8}'),
        obs("calibration", '{"axis": "comedy", "value": 2}'),
      ]),
      false,
      true,
    );
    expect(calibrated).toEqual([]);
  });

  it("the vision floor follows the SYNTHESIS, not the absence of a row (research-then-original)", () => {
    // A table that researched a title and then chose its own world anyway
    // still compiles the STUB — so the bar is what it always was: something to
    // synthesize from. A stored profile row does not excuse it.
    const thin = gapVerdict(resolveObservations(VISIONLESS), true, true);
    expect(thin.some((g) => g.includes("needs its vision spoken"))).toBe(true);
    // Nothing failed to load here, so the anchored complaint stays silent.
    expect(thin.some((g) => g.includes("no researched profile"))).toBe(false);
    expect(gapVerdict(resolveObservations(SCRIPTED_OBSERVATIONS), true, true)).toEqual([]);
  });

  it("the original-world word never excuses the rest of the table", () => {
    const sparkless = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "spark")),
      false,
      true,
    );
    expect(sparkless.some((g) => g.includes("spark"))).toBe(true);
  });
});

describe("presentation directive resolution (M3-DG, deterministic)", () => {
  it("resolves structured device grants latest-wins per name; malformed defers", () => {
    const r = resolveObservations([
      obs("presentation_directive", '{"name": "readout", "skin": "Lilith\'s machine"}'),
      obs("presentation_directive", '{"name": "memory", "skin": "a sepia flashback"}'),
      // Re-skin the same device — the newer grant wins, not a duplicate.
      obs("presentation_directive", '{"name": "readout", "skin": "the tactical overlay"}'),
      // A device with no skin is valid (the plain device).
      obs("presentation_directive", '{"name": "title"}'),
      // A bad name defers; junk JSON defers — neither poisons the contract.
      obs("presentation_directive", '{"name": "hologram", "skin": "shiny"}'),
      obs("presentation_directive", "just give it some flair"),
    ]);
    expect(r.directiveGrants).toContainEqual({ name: "readout", skin: "the tactical overlay" });
    expect(r.directiveGrants).toContainEqual({ name: "memory", skin: "a sepia flashback" });
    expect(r.directiveGrants).toContainEqual({ name: "title", skin: "" });
    expect(r.directiveGrants).toHaveLength(3);
    expect(r.parseFailures.filter((d) => d.includes("presentation directive"))).toHaveLength(2);
  });

  it("prose presentation grants stay prose — the structured half is separate", () => {
    const r = resolveObservations([
      obs("presentation", "bare prose; episode-title cards only"),
      obs("presentation_directive", '{"name": "readout", "skin": "the machine"}'),
    ]);
    expect(r.presentationGrants).toEqual(["bare prose; episode-title cards only"]);
    expect(r.directiveGrants).toEqual([{ name: "readout", skin: "the machine" }]);
  });
});

describe.skipIf(!url)("SZ compiler (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "sz@example.com" });
    // A stub profile row satisfying the Profile contract (fixture-derived).
    const contract = bebopContract();
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile",
        title: "Cowboy Bebop",
        profile: {
          id: "test_sz_profile",
          title: "Cowboy Bebop",
          alternate_titles: [],
          media_type: "anime",
          status: "completed",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: contract.canonical.voice.author_voice,
            voice_cards: [],
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: contract.canonical.voice.director_personality,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
        },
      })
      .onConflictDoNothing();
    // Second source for the hybrid fixture — content reused, identity distinct.
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile_b",
        title: "Solo Leveling",
        profile: {
          id: "test_sz_profile_b",
          title: "Solo Leveling",
          alternate_titles: [],
          media_type: "anime",
          status: "completed",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: contract.canonical.voice.author_voice,
            voice_cards: [],
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: contract.canonical.voice.director_personality,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
        },
      })
      .onConflictDoNothing();
    // M3R3 C4a anchor: same world, but it CARRIES voice matter to leak.
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile_voice",
        title: "Cowboy Bebop",
        profile: {
          id: "test_sz_profile_voice",
          title: "Cowboy Bebop",
          alternate_titles: [],
          media_type: "anime",
          status: "completed",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: ANCHOR_AUTHOR_VOICE,
            voice_cards: ANCHOR_CARDS,
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: ANCHOR_DIRECTOR,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
        },
      })
      .onConflictDoNothing();
    // M3R3 C4b audit: the exact-guard pair. A RESEARCHED profile whose id
    // begins with "original_" — research.ts mints `profileSlug(title)`, so
    // "Original Sin" is stored exactly like this — and a `player_vision`
    // record whose id carries no prefix at all. The original-world branch must
    // read the RECORD in both directions, never the id.
    await db
      .insert(schema.profiles)
      .values({
        id: "original_sin",
        title: "Original Sin",
        profile: {
          id: "original_sin",
          title: "Original Sin",
          alternate_titles: [],
          media_type: "anime",
          status: "completed",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: ANCHOR_AUTHOR_VOICE,
            voice_cards: ANCHOR_CARDS,
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: ANCHOR_DIRECTOR,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
          research_trust: { method: "api_wiki", derived_confidence: 80 },
        },
      })
      .onConflictDoNothing();
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile_vision",
        title: "A Table's Own World",
        profile: {
          id: "test_sz_profile_vision",
          title: "A Table's Own World",
          alternate_titles: [],
          media_type: "anime",
          status: "ongoing",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: ANCHOR_AUTHOR_VOICE,
            voice_cards: ANCHOR_CARDS,
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: ANCHOR_DIRECTOR,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
          research_trust: { method: "player_vision", derived_confidence: 95 },
        },
      })
      .onConflictDoNothing();
    const draft: ConductorDraft = {
      transcript: [{ role: "user", content: "let's play bebop" }],
      observations: SCRIPTED_OBSERVATIONS,
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "SZ compile fixture", status: "draft", szTranscript: draft })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile"));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile_b"));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile_voice"));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "original_sin"));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile_vision"));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("resolution is latest-wins and calibration parses per axis", () => {
    const resolved = resolveObservations([
      ...SCRIPTED_OBSERVATIONS,
      obs("calibration", '{"axis": "darkness", "value": 6}'),
    ]);
    expect(resolved.calibration.darkness).toBe(6);
    expect(resolved.spark).toContain("whatever happens");
    expect(resolved.finitude).toBe("finite");
  });

  it("finitude never inverts and never guesses (§8 sacrosanct)", () => {
    const indefinite = resolveObservations([
      obs("finitude", "indefinite — an open monster-of-the-week cycle"),
    ]);
    expect(indefinite.finitude).toBe("indefinite");
    const undecided = resolveObservations([obs("finitude", "they're undecided for now")]);
    expect(undecided.finitude).toBe("undecided");
    // The chosen word leads (the conductor is told to record it first) —
    // a trailing mention of the other word must not flip it.
    const both = resolveObservations([
      obs("finitude", "finite — they considered indefinite but want a real ending"),
    ]);
    expect(both.finitude).toBe("finite");
    // Ambiguous mid-string mentions of BOTH words resolve to nothing: the
    // gap verdict blocks a guessed Series contract rather than shipping one.
    const ambiguous = resolveObservations([
      obs("finitude", "torn between a finite run and letting it go on indefinitely"),
    ]);
    expect(ambiguous.finitude).toBeUndefined();
    expect(ambiguous.parseFailures.some((d) => d.includes("ambiguous finitude"))).toBe(true);
  });

  it("a malformed tier_selection defers instead of throwing", () => {
    const resolved = resolveObservations([obs("tier_selection", "sonnet for everything please")]);
    expect(resolved.tierSelection).toBeUndefined();
    expect(resolved.parseFailures.some((d) => d.includes("tier selection"))).toBe(true);
  });

  it("blend choices resolve latest-wins per component; malformed ones defer", () => {
    const resolved = resolveObservations([
      obs("blend", '{"component": "world", "choice": "Solo Leveling"}'),
      obs("blend", '{"component": "framing", "choice": "Cowboy Bebop"}'),
      obs("blend", '{"component": "world", "choice": "Cowboy Bebop"}'),
      obs("blend", "mostly bebop I guess"),
    ]);
    expect(resolved.blendChoices).toContainEqual({ component: "world", choice: "Cowboy Bebop" });
    expect(resolved.blendChoices).toHaveLength(2);
    expect(resolved.parseFailures.some((d) => d.includes("unparseable blend"))).toBe(true);
  });

  it("a hybrid draft compiles single-source from the player's WORLD pick, recipe carried (M1, user-ratified)", async () => {
    if (!db) throw new Error("unreachable");
    const hybridDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        obs("blend", '{"component": "world", "choice": "Solo Leveling"}'),
        obs("blend", '{"component": "framing", "choice": "Cowboy Bebop"}'),
      ],
      // Bebop was researched FIRST — the world pick must still win the base.
      profileIds: ["test_sz_profile", "test_sz_profile_b"],
      readyToCompile: true,
    };
    const [hybrid] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "hybrid fixture", status: "draft", szTranscript: hybridDraft })
      .returning();
    if (!hybrid) throw new Error("insert failed");
    try {
      const result = await compileSessionZero(db, hybrid.id, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      expect(result.contract.hybrid_recipe?.world.source_profile_ids).toEqual([
        "test_sz_profile_b",
      ]);
      expect(result.contract.hybrid_recipe?.framing.notes).toContain("Cowboy Bebop");
      expect(result.contract.anchors_used).toContain("test_sz_profile");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, hybrid.id));
    }
  });

  it("player canon joins anchors_used and canon-matching, never profileIds (M3R3 C2)", async () => {
    if (!db) throw new Error("unreachable");
    const withCanon: ConductorDraft = {
      transcript: [],
      observations: SCRIPTED_OBSERVATIONS,
      profileIds: ["test_sz_profile"],
      playerCanonId: "player_canon_abc",
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "player canon fixture", status: "draft", szTranscript: withCanon })
      .returning();
    if (!campaign) throw new Error("insert failed");
    let seenProfileIds: string[] = [];
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async (_db, _cid, _turn, _text, opts) => {
          seenProfileIds = [...opts.profileIds];
          return { writes: [], flags: [] };
        },
      });
      expect(result.gaps).toEqual([]);
      // Retrieval reads anchors_used — the pasted canon must be IN it, in
      // order, or it was written and can never be read.
      expect(result.contract.anchors_used).toEqual(["test_sz_profile", "player_canon_abc"]);
      // …and the resolver sees it too, so a pasted name isn't minted twice.
      expect(seenProfileIds).toEqual(["test_sz_profile", "player_canon_abc"]);
      // It is NOT a second source: the hybrid switch (profileIds.length > 1)
      // stays off, so no hybrid_recipe appears.
      expect(result.contract.hybrid_recipe).toBeUndefined();
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("binds ONE protagonist npc from overlapping self-insert briefs (§6.5)", async () => {
    if (!db) throw new Error("unreachable");
    // Today's live defect: two cast_facts about the self-insert (one backstory-
    // flavored, one capabilities-flavored) plus world facts mentioning him, and
    // the OSP minted the protagonist TWICE under two placeholder names — plus a
    // pair of same-relationship threads under DIFFERENT names.
    const draft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        // Latest-wins override to the deferral form: this fixture's protagonist
        // stays "The Protagonist" (unnamed by the player's own word), which the
        // dedup assertions below depend on — and proves the deferred path compiles.
        obs("pc_name", "deferred — the player wants the name to emerge in play"),
        obs("cast_fact", "The protagonist was orphaned in the lower wards and never named."),
        obs("cast_fact", "The protagonist can channel stormlight into a blade — a rare ability."),
        obs("world_fact", "The lower wards raised the protagonist and half the crew."),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "protagonist dedup fixture",
        status: "draft",
        szTranscript: draft,
      })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const PROTAGONIST_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "The Protagonist (unnamed)",
          kind: "cast" as const,
          brief: "Orphaned in the lower wards; carries a dead mentor's compass. Never named.",
          admit_to_catalog: true,
        },
        {
          name: "player's protagonist",
          kind: "cast" as const,
          brief: "A duelist whose ability channels stormlight into a blade.",
          admit_to_catalog: true,
        },
        {
          name: "Lloyd and protagonist connection",
          kind: "thread" as const,
          brief: "Their paths keep tangling on the docks.",
          admit_to_catalog: true,
        },
        {
          name: "Path-Crossing with Lloyd",
          kind: "thread" as const,
          brief: "Lloyd reappears wherever the crew lands.",
          admit_to_catalog: true,
        },
      ],
    };
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async () => PROTAGONIST_STUB,
        // No-op ingestor: the dedup under test is the brief-admission path, kept
        // isolated from ingestion-minted entities (§6.5 fix scope).
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);

      const rows = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.campaignId, campaign.id));
      const npcs = rows.filter((e) => e.entityType === "npc");
      // Exactly ONE protagonist npc, carrying BOTH facts' material.
      expect(npcs).toHaveLength(1);
      expect(npcs[0]?.name).toBe("The Protagonist");
      expect(npcs[0]?.block).toContain("lower wards");
      expect(npcs[0]?.block).toContain("stormlight");
      // Its version-1 row mirrors the merged block (rewind base intact).
      const versions = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, npcs[0]?.id ?? ""));
      expect(versions).toHaveLength(1);
      expect(versions[0]?.block).toBe(npcs[0]?.block);
      // The two same-relationship threads have DIFFERENT names — deterministic
      // dedup leaves them as two rows (M2 semantic-alias territory).
      const threads = rows.filter((e) => e.entityType === "thread");
      expect(threads).toHaveLength(2);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a named PC seeds the protagonist row EXACTLY that name, state-stamped; the OSP gets the name (M2 C4)", async () => {
    if (!db) throw new Error("unreachable");
    const named: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name"),
        obs("pc_name", "Kaelen — he chose it himself"),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "named pc fixture", status: "draft", szTranscript: named })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const NAMED_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "The Protagonist (unnamed)",
          kind: "cast" as const,
          brief: "The player's self-insert; a wandering blade who carries a dead mentor's compass.",
          admit_to_catalog: true,
        },
      ],
    };
    let seenPcName: string | undefined;
    let seenPcConcept: string | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenPcName = input.resolved.pcName;
          seenPcConcept = input.resolved.pcConcept;
          return NAMED_STUB;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The OSP synthesizer receives the name (briefs/opening can use it) —
      // and the concept (SV2: the protagonist brief's anchor).
      expect(seenPcName).toBe("Kaelen");
      expect(seenPcConcept).toContain("bounty hunter");

      const npcs = await db
        .select()
        .from(schema.entities)
        .where(
          and(eq(schema.entities.campaignId, campaign.id), eq(schema.entities.entityType, "npc")),
        );
      expect(npcs).toHaveLength(1);
      // The row is named EXACTLY the player's word.
      expect(npcs[0]?.name).toBe("Kaelen");
      // …and stamped so the resolver's protagonist alias survives the real name.
      expect((npcs[0]?.state as { is_player_protagonist?: boolean })?.is_player_protagonist).toBe(
        true,
      );
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a deferred PC compiles: row stays 'The Protagonist', the deferral note is recorded (M2 C4)", async () => {
    if (!db) throw new Error("unreachable");
    const deferredDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name"),
        obs("pc_name", "deferred — the player wants the name to emerge in play"),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "deferred pc fixture",
        status: "draft",
        szTranscript: deferredDraft,
      })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const DEFERRED_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "player's protagonist",
          kind: "cast" as const,
          brief: "The self-insert lead, as yet unnamed.",
          admit_to_catalog: true,
        },
      ],
    };
    let seenDeferred: string[] = [];
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenDeferred = [...input.resolved.playerDeferred];
          return DEFERRED_STUB;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The deferral surfaces to the OSP (and the conductor's open-items summary).
      expect(seenDeferred.some((d) => d.includes("protagonist name deferred"))).toBe(true);

      const npcs = await db
        .select()
        .from(schema.entities)
        .where(
          and(eq(schema.entities.campaignId, campaign.id), eq(schema.entities.entityType, "npc")),
        );
      expect(npcs).toHaveLength(1);
      expect(npcs[0]?.name).toBe("The Protagonist");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a gap-≥2 table compiles: tier on the contract, framing moves override ACTIVE only (SV3)", async () => {
    if (!db) throw new Error("unreachable");
    const opDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        obs("pc_power_tier", '{"tier": "T5", "baseline": "T8"}'),
        obs("framing_choice", '{"axis": "tension_source", "value": "burden"}'),
        obs("framing_choice", '{"axis": "mode", "value": "op_dominant"}'),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "op tier fixture", status: "draft", szTranscript: opDraft })
      .returning();
    if (!campaign) throw new Error("insert failed");
    let seenTier: string | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenTier = input.resolved.pcPowerTier;
          return STUB_OSP;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The circuit's contract half: the chosen tier lands, typed.
      expect(result.contract.pc_power_tier).toBe("T5");
      // Framing moves land as ACTIVE-layer overrides; canonical keeps the
      // source's own framing (calibration's exact discipline).
      expect(result.contract.active.framing.tension_source).toBe("burden");
      expect(result.contract.active.framing.mode).toBe("op_dominant");
      expect(result.contract.canonical.framing.tension_source).toBe("existential");
      expect(result.contract.canonical.framing.mode).toBe("standard");
      // The OSP hears about the elevation (no struggle-scene cold opens).
      expect(seenTier).toBe("T5");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("the China Shop table compiles WHOLE: gloss placed, law carved into layer 9 AND Block 1", async () => {
    if (!db) throw new Error("unreachable");
    const LAW_CLAUSE = "There is no cost to Kami's power and no loss of control.";
    const lawDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        obs(
          "framing_choice",
          '{"axis": "power_expression", "value": "overwhelming — force is rarely in doubt"}',
        ),
        obs(
          "framing_choice",
          '{"axis": "tension_source", "value": "collateral consequence — who pays the cost when he wins"}',
        ),
        obs("premise_law", LAW_CLAUSE),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "law channel fixture", status: "draft", szTranscript: lawDraft })
      .returning();
    if (!campaign) throw new Error("insert failed");
    let seenLaws: string[] = [];
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenLaws = [...input.resolved.premiseLaws];
          return STUB_OSP;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The gloss was never the defect: the correct token places on the axis.
      expect(result.contract.active.framing.power_expression).toBe("overwhelming");
      // …and the resolution the instrument cannot hold is on the contract.
      const carved = "tension_source: collateral consequence — who pays the cost when he wins";
      expect(result.contract.premise_laws).toEqual([carved, LAW_CLAUSE]);
      expect(seenLaws).toEqual([carved, LAW_CLAUSE]);

      // Reader 1 — layer 9: every conte's hard_constraints, verbatim.
      const facts = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, campaign.id));
      const lawRow = facts.find((f) => f.content === LAW_CLAUSE);
      expect(lawRow?.provenance).toBe("sz_resolution");
      expect(lawRow?.category).toBe("sz_fact");
      expect(lawRow?.confidence).toBe(1);
      expect(facts.some((f) => f.content === carved)).toBe(true);

      // Reader 2 — Block 1's world-rules freight, on the control key's
      // precedent: obeyed text the pen reads every turn, and NOT charter
      // budget (the §4.4a 600-900 window is untouched by a law).
      const settei = renderSettei({ contract: result.contract, marks: [] });
      expect(settei.text).toContain("Premise law (the player's word");
      expect(settei.text).toContain(LAW_CLAUSE);
      expect(settei.text).toContain("collateral consequence");
      const lawless = renderSettei({
        contract: { ...result.contract, premise_laws: [] },
        marks: [],
      });
      expect(settei.charterTokens).toBe(lawless.charterTokens);
      expect(settei.tokens).toBeGreaterThan(lawless.tokens);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  // --- M3R3 C4a: canonicality compiles (lesson L6) --------------------------
  // The live defect: an "inspired" original received the anchor profile's
  // VERBATIM voice matter — the anchor protagonist's voice pressuring an
  // original story (Elymas Edvan in Deus Versus). These four pin the branch.

  /** Compile a draft against the voice-carrying anchor with a canonicality override. */
  async function compileWithCanonicality(
    title: string,
    canonicality: string,
    extra: Observation[] = [],
    opts: { profileIds?: string[] } = {},
  ) {
    if (!db) throw new Error("unreachable");
    const draft: ConductorDraft = {
      transcript: [],
      // The scripted canonicality is dropped rather than merged under: these
      // cases turn on what the conversation did NOT walk (an inspired premise
      // never walks the cast door), and a merge would quietly supply the axis
      // the derivation exists to fill.
      observations: [
        ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "canonicality"),
        obs("canonicality", canonicality),
        ...extra,
      ],
      profileIds: opts.profileIds ?? ["test_sz_profile_voice"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title, status: "draft", szTranscript: draft })
      .returning();
    if (!campaign) throw new Error("insert failed");
    let seenDeferred: string[] = [];
    let seenPrompt = "";
    let seenOspDirector = "";
    let seenIngestCanonicality: { timeline_mode?: string; canon_cast_mode?: string } | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenDeferred = [...input.resolved.playerDeferred];
          seenOspDirector = input.directorPersonality;
          return STUB_OSP;
        },
        ingestor: async (_db, _campaignId, _turnNumber, _text, ingestOpts) => {
          seenIngestCanonicality = ingestOpts.canonicality;
          return { writes: [], flags: [] };
        },
      });
      const call = mockJudgment.mock.calls.find(
        (c) => (c[1] as { name?: string })?.name === "compile_voice_transposition",
      );
      seenPrompt = (call?.[1] as { prompt?: string })?.prompt ?? "";
      return { result, seenDeferred, seenPrompt, seenOspDirector, seenIngestCanonicality };
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  }

  it("inspired: the cards are DROPPED and the craft is TRANSPOSED, posture untouched", async () => {
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED);
    const { result, seenPrompt, seenOspDirector } = await compileWithCanonicality(
      "inspired fixture",
      '{"timeline_mode": "inspired"}',
    );
    expect(result.gaps).toEqual([]);

    const voice = result.contract.active.voice;
    // The cards describe people who may not exist in this story — gone whole.
    expect(voice.voice_cards).toEqual([]);
    // The HAND survives, but it is the transposed hand, not the anchor's.
    expect(voice.author_voice).toEqual(TRANSPOSED.author_voice);
    expect(voice.director_personality).toBe(TRANSPOSED.director_personality);
    expect(voice.director_personality).not.toBe(ANCHOR_DIRECTOR);
    // cast_depth_posture is STRUCTURAL (how deep a tier is drawn, not who
    // fills it) — it rides verbatim on every path.
    expect(voice.cast_depth_posture).toEqual(bebopContract().canonical.voice.cast_depth_posture);
    // Both layers are conditioned: a canonical layer holding the dropped
    // matter would smuggle it back through any future canonical read.
    expect(result.contract.canonical.voice.voice_cards).toEqual([]);
    expect(result.contract.canonical.voice.author_voice).toEqual(TRANSPOSED.author_voice);

    // The call is grounded in THIS campaign: spark verbatim + its own matter.
    expect(seenPrompt).toContain("whatever happens, happens");
    expect(seenPrompt).toContain("fishing trawler");
    expect(seenPrompt).toContain("bounty hunter"); // the pc_concept

    // The THIRD copy point: the OSP synthesis reads the CONDITIONED voice too.
    // Its briefs become catalog entities the player meets in scene one, so
    // anchor idiom riding in here is a leak with a longer life than the prompt.
    expect(seenOspDirector).toBe(TRANSPOSED.director_personality);
    expect(seenOspDirector).not.toBe(ANCHOR_DIRECTOR);
  });

  it("inspired with the cast door unwalked: the axis DERIVES to npcs_only, both gates included", async () => {
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED);
    // The conductor skips door 2 entirely for inspired, so this — timeline only
    // — is the NORMAL inspired observation. Defaulting it to full_cast armed the
    // ingestion cast gate and the Pacer's cast directive against the original
    // characters of an original story.
    const { result, seenIngestCanonicality } = await compileWithCanonicality(
      "inspired derived cast fixture",
      '{"timeline_mode": "inspired"}',
    );
    expect(result.gaps).toEqual([]);
    expect(result.contract.active.canonicality.canon_cast_mode).toBe("npcs_only");
    expect(result.contract.canonical.canonicality.canon_cast_mode).toBe("npcs_only");
    // The same pair the gates were handed — one derivation, no drift.
    expect(seenIngestCanonicality).toEqual({
      timeline_mode: "inspired",
      canon_cast_mode: "npcs_only",
    });
  });

  it("inspired + a FAILED transposition degrades to structure — it never fails open", async () => {
    mockJudgment.mockReset();
    armTransposition(() => {
      throw new Error("transposition boom");
    });
    const { result, seenDeferred } = await compileWithCanonicality(
      "inspired degrade fixture",
      '{"timeline_mode": "inspired"}',
    );
    expect(result.gaps).toEqual([]);

    const av = result.contract.active.voice.author_voice;
    // The name-free STRUCTURE survives…
    expect(av.sentence_patterns).toEqual(ANCHOR_AUTHOR_VOICE.sentence_patterns);
    expect(av.structural_motifs).toEqual(ANCHOR_AUTHOR_VOICE.structural_motifs);
    expect(av.emotional_rhythm).toEqual(ANCHOR_AUTHOR_VOICE.emotional_rhythm);
    // …and the two channels made of the anchor's own words do NOT.
    expect(av.dialogue_quirks).toEqual([]);
    expect(av.example_voice).toBe("");
    expect(result.contract.active.voice.voice_cards).toEqual([]);
    // The IP-specific directing voice is rebuilt from the campaign's spark,
    // never inherited — carrying it verbatim is the leak this commit kills.
    expect(result.contract.active.voice.director_personality).not.toBe(ANCHOR_DIRECTOR);
    expect(result.contract.active.voice.director_personality).toContain(
      "whatever happens, happens",
    );
    // The degrade is SAID, not swallowed — it reaches the OSP's open items.
    expect(seenDeferred.some((d) => d.includes("voice transposition failed"))).toBe(true);
  });

  it("replaced_protagonist: ONLY the replaced seat's card leaves; a miss drops nothing", async () => {
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED); // must never fire on this path
    const hit = await compileWithCanonicality(
      "replaced pc fixture",
      '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "replaced_protagonist"}',
      [obs("pc_name", "Spike Spiegel — the player took the seat")],
    );
    expect(hit.result.gaps).toEqual([]);
    const kept = hit.result.contract.active.voice.voice_cards;
    expect(kept.map((c) => c.name)).toEqual(["Faye Valentine"]);
    // Every other card is untouched — this is a surgical drop, not a purge.
    expect(kept[0]).toEqual(ANCHOR_CARDS[1]);
    // The craft is the source's craft here: the timeline is still canon.
    expect(hit.result.contract.active.voice.author_voice).toEqual(ANCHOR_AUTHOR_VOICE);
    expect(hit.result.contract.active.voice.director_personality).toBe(ANCHOR_DIRECTOR);
    expect(
      mockJudgment.mock.calls.some(
        (c) => (c[1] as { name?: string })?.name === "compile_voice_transposition",
      ),
    ).toBe(false);

    // A name matching NO card drops nothing: the player's self-report is
    // authoritative for the MODE; the identity test only picks WHICH card.
    const miss = await compileWithCanonicality(
      "replaced pc miss fixture",
      '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "replaced_protagonist"}',
      [obs("pc_name", "Kaelen — an original lead in the canon seat")],
    );
    expect(miss.result.contract.active.voice.voice_cards).toEqual(ANCHOR_CARDS);
  });

  it("full_cast + canon_adjacent: the voice is BYTE-IDENTICAL to the anchor (deliberate verbatim)", async () => {
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED); // must never fire on this path
    const { result, seenOspDirector, seenIngestCanonicality } = await compileWithCanonicality(
      "full cast fixture",
      '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "full_cast"}',
    );
    expect(result.gaps).toEqual([]);
    expect(result.contract.active.voice).toEqual({
      author_voice: ANCHOR_AUTHOR_VOICE,
      voice_cards: ANCHOR_CARDS,
      director_personality: ANCHOR_DIRECTOR,
      cast_depth_posture: bebopContract().canonical.voice.cast_depth_posture,
    });
    // Reading the CONDITIONED voice at the OSP call is behavior-neutral here:
    // off the inspired path conditionVoice hands back the profile's own string.
    expect(seenOspDirector).toBe(ANCHOR_DIRECTOR);
    // A stated cast door is carried, never re-derived.
    expect(seenIngestCanonicality).toEqual({
      timeline_mode: "canon_adjacent",
      canon_cast_mode: "full_cast",
    });
    expect(mockJudgment).not.toHaveBeenCalled();
  });

  it("the original-world branch is EXACT: it reads the trust record, never the id prefix", async () => {
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED);
    // "Original Sin" is stored as `original_sin` (research.ts profileSlug), so
    // an id-prefix guard sent a RESEARCHED anchor down the verbatim branch and
    // shipped its cast's voice cards into an inspired original story — failing
    // open into the exact leak C4a exists to close. Pinned dead.
    const leak = await compileWithCanonicality(
      "original-prefixed anchor fixture",
      '{"timeline_mode": "inspired"}',
      [],
      { profileIds: ["original_sin"] },
    );
    expect(leak.result.gaps).toEqual([]);
    const leaked = leak.result.contract.active.voice;
    expect(leaked.voice_cards).toEqual([]);
    expect(leaked.author_voice).toEqual(TRANSPOSED.author_voice);
    expect(leaked.director_personality).toBe(TRANSPOSED.director_personality);
    expect(JSON.stringify(leak.result.contract)).not.toContain("Spike Spiegel");
    expect(
      mockJudgment.mock.calls.some(
        (c) => (c[1] as { name?: string })?.name === "compile_voice_transposition",
      ),
    ).toBe(true);

    // The other direction: a `player_vision` record rides VERBATIM on the same
    // inspired timeline, with no prefix on its id and no transposition bought.
    mockJudgment.mockReset();
    armTransposition(() => TRANSPOSED); // firing at all is the failure here
    const own = await compileWithCanonicality(
      "player-vision record fixture",
      '{"timeline_mode": "inspired"}',
      [],
      { profileIds: ["test_sz_profile_vision"] },
    );
    expect(own.result.gaps).toEqual([]);
    expect(own.result.contract.active.voice.voice_cards).toEqual(ANCHOR_CARDS);
    expect(own.result.contract.active.voice.author_voice).toEqual(ANCHOR_AUTHOR_VOICE);
    expect(own.result.contract.active.voice.director_personality).toBe(ANCHOR_DIRECTOR);
    expect(mockJudgment).not.toHaveBeenCalled();
  });

  // --- M3R3 C4b: the true-original path (lesson L6) -------------------------
  // v3 transposed nothing because it never LOADED a profile: generate_custom_
  // profile built original worlds with no voice cards, DNA from calibration and
  // creative fields from the player's stated vision. "No anchor" was an ERROR
  // state in v5 until here.

  /** A table with no source at all — the player's own world, spoken. */
  const ORIGINAL_OBSERVATIONS: Observation[] = [
    // The scripted canonicality names a canon timeline; an original world has
    // no canon, so it is dropped and the derivation runs — which puts this
    // fixture on the `inspired` branch, exactly where the transposition WOULD
    // fire without C4b's guard.
    ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "canonicality"),
    obs("world_fact", "The Ledgermen keep the book and never forgive a line"),
  ];

  async function compileOriginal(
    title: string,
    opts: { failWorldCall?: boolean; profileIds?: string[]; extra?: Observation[] } = {},
  ) {
    if (!db) throw new Error("unreachable");
    const draft: ConductorDraft = {
      transcript: [],
      observations: [...ORIGINAL_OBSERVATIONS, ...(opts.extra ?? [])],
      profileIds: opts.profileIds ?? [],
      originalWorld: true,
      readyToCompile: true,
    };
    mockJudgment.mockReset();
    armOriginalSynthesis(opts);
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title, status: "draft", szTranscript: draft })
      .returning();
    if (!campaign) throw new Error("insert failed");
    return { campaign, stubId: `original_${campaign.id}` };
  }

  it("an original world compiles: the stub is synthesized, persisted, and carries NO voice cards", async () => {
    if (!db) throw new Error("unreachable");
    const { campaign, stubId } = await compileOriginal("original world fixture");
    let seenOspTitle = "";
    let seenOspDirector = "";
    let seenIngestProfileIds: string[] = [];
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenOspTitle = input.title;
          seenOspDirector = input.directorPersonality;
          return STUB_OSP;
        },
        ingestor: async (_db, _cid, _turn, _text, ingestOpts) => {
          seenIngestProfileIds = [...ingestOpts.profileIds];
          return { writes: [], flags: [] };
        },
      });
      expect(result.gaps).toEqual([]);

      // Both halves of the synthesis fired — and the transposition did NOT.
      // A voice written for THIS campaign has no source nouns to launder.
      const names = mockJudgment.mock.calls.map((c) => (c[1] as { name?: string })?.name);
      expect(names).toContain("compile_original_treatment");
      expect(names).toContain("compile_original_world");
      expect(names).not.toContain("compile_voice_transposition");

      // The stub is a real profiles row, scoped to THIS campaign — an original
      // world is one table's truth, never shared IP.
      const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, stubId));
      expect(row?.title).toBe("The Kettle Reach");
      expect(row?.scopeClass).toBe("micro");
      const stub = row?.profile as {
        ip_mechanics: {
          voice_cards: unknown[];
          storytelling_tropes: Record<string, boolean>;
          stat_mapping: { has_canonical_stats: boolean };
          power_system?: unknown;
        };
        research_trust: {
          method: string;
          derived_confidence: number;
          sources_consulted: string[];
          pages_fetched: number;
          field_sources: Record<string, string>;
          coverage_gaps: string[];
          defective: boolean;
          grounding: string;
        };
      };
      // THE assertion of the commit: [] by construction, not by a filter.
      expect(stub.ip_mechanics.voice_cards).toEqual([]);
      // v3 parity: every trope off — they evolve during play.
      expect(Object.values(stub.ip_mechanics.storytelling_tropes)).toHaveLength(15);
      expect(Object.values(stub.ip_mechanics.storytelling_tropes).some(Boolean)).toBe(false);
      // The player never asked for a stat system, so none was invented.
      expect(stub.ip_mechanics.stat_mapping.has_canonical_stats).toBe(false);
      expect(stub.ip_mechanics.power_system).toBeUndefined();
      // The trust record says what this is: no source to be wrong about.
      expect(stub.research_trust.method).toBe("player_vision");
      expect(stub.research_trust.derived_confidence).toBe(95);
      expect(stub.research_trust.sources_consulted).toEqual(["player"]);
      expect(stub.research_trust.pages_fetched).toBe(0);
      expect(stub.research_trust.field_sources.canonical_dna).toBe("player");
      expect(stub.research_trust.field_sources.author_voice).toBe("player");
      // Absence IS the label for organs nothing fed (trust.ts's discipline).
      expect(stub.research_trust.field_sources.stat_mapping).toBeUndefined();
      expect(stub.research_trust.field_sources.voice_cards).toBeUndefined();
      expect(stub.research_trust.coverage_gaps).toEqual([]);
      expect(stub.research_trust.defective).toBe(false);
      expect(stub.research_trust.grounding).toBe("no_claims");
      expect((row?.researchProvenance as { notes: string[] }).notes[0]).toContain("original world");

      // Retrieval and the ingestion resolver both read anchors_used.
      expect(result.contract.anchors_used).toEqual([stubId]);
      expect(seenIngestProfileIds).toEqual([stubId]);
      // The synthesized gauge IS the canonical layer; the player's calibration
      // still moves only the active one (the two-layer discipline is untouched).
      expect(result.contract.canonical.treatment.darkness).toBe(3);
      expect(result.contract.active.treatment.darkness).toBe(8);
      expect(result.contract.canonical.framing.narrative_focus).toBe("party");
      // The voice rides VERBATIM here, and that needs no defense: it was
      // written for this campaign out of this player's vision.
      expect(result.contract.active.voice.voice_cards).toEqual([]);
      expect(result.contract.active.voice.author_voice).toEqual(ORIGINAL_WORLD.author_voice);
      expect(result.contract.active.voice.director_personality).toBe(
        ORIGINAL_WORLD.director_personality,
      );
      // The OSP synthesis works from the world's own name and voice.
      expect(seenOspTitle).toBe("The Kettle Reach");
      expect(seenOspDirector).toBe(ORIGINAL_WORLD.director_personality);

      const [after] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      expect(after?.status).toBe("active");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, stubId));
    }
  });

  it("research THEN original: the player's latest word wins the base; the anchors ride as reference corpora", async () => {
    if (!db) throw new Error("unreachable");
    // "I looked at some sources, but this is MY world." Before the fix the
    // flag went INERT the moment any profile row loaded — and profileIds has
    // no removal path, so the retraction was unreachable forever after.
    const { campaign, stubId } = await compileOriginal("research then original fixture", {
      profileIds: ["test_sz_profile_voice", "test_sz_profile_b"],
    });
    let seenIngestProfileIds: string[] = [];
    let seenDeferred: string[] = [];
    let seenOspTitle = "";
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenOspTitle = input.title;
          seenDeferred = [...input.resolved.playerDeferred];
          return STUB_OSP;
        },
        ingestor: async (_db, _cid, _turn, _text, ingestOpts) => {
          seenIngestProfileIds = [...ingestOpts.profileIds];
          return { writes: [], flags: [] };
        },
      });
      expect(result.gaps).toEqual([]);

      // The stub was synthesized and IS the base — no transposition, because
      // there is no source hand in the contract to launder.
      const names = mockJudgment.mock.calls.map((c) => (c[1] as { name?: string })?.name);
      expect(names).toContain("compile_original_world");
      expect(names).not.toContain("compile_voice_transposition");
      // Treatment, framing, world and voice ALL compile from the stub — the
      // anchor's own DNA (darkness 7, ensemble focus, the Bebop) is nowhere.
      expect(result.contract.canonical.treatment.darkness).toBe(3);
      expect(result.contract.canonical.framing.narrative_focus).toBe("party");
      expect(result.contract.canonical.world.world_setting.locations).toEqual([
        "The Kettle",
        "Lowwater Market",
      ]);
      expect(result.contract.active.voice.voice_cards).toEqual([]);
      expect(result.contract.active.voice.author_voice).toEqual(ORIGINAL_WORLD.author_voice);
      expect(result.contract.active.voice.director_personality).toBe(
        ORIGINAL_WORLD.director_personality,
      );
      const serialized = JSON.stringify(result.contract);
      expect(serialized).not.toContain("Spike Spiegel");
      expect(serialized).not.toContain(ANCHOR_DIRECTOR);
      expect(serialized).not.toContain("clipped, jazz-phrased");
      expect(seenOspTitle).toBe("The Kettle Reach");

      // The researched rows are REFERENCE CORPORA: still retrievable, still
      // canon-matched by the resolver, but AFTER the stub and never the base.
      expect(result.contract.anchors_used).toEqual([
        stubId,
        "test_sz_profile_voice",
        "test_sz_profile_b",
      ]);
      expect(seenIngestProfileIds).toEqual(result.contract.anchors_used);
      // Two anchors, and still no blend: an original world is not a component,
      // so there is no base to pick between and no recipe to record.
      expect(result.contract.hybrid_recipe).toBeUndefined();
      expect(seenDeferred.some((d) => d.includes("hybrid premise"))).toBe(false);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, stubId));
    }
  });

  it("an original world FORCES its axes: a stray canonicality record cannot claim a source that does not exist", async () => {
    if (!db) throw new Error("unreachable");
    // The conductor's itinerary walks the canonicality beat unconditionally,
    // so this record is reachable on an original table. Defaulted (not forced)
    // it made the contract claim canon-adjacency to nothing, and armed the
    // full_cast cast gate against the player's own characters.
    const { campaign, stubId } = await compileOriginal("original forced axes fixture", {
      extra: [
        obs(
          "canonicality",
          '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "full_cast", "event_fidelity": "background"}',
        ),
      ],
    });
    let seenIngestCanonicality: { timeline_mode?: string; canon_cast_mode?: string } | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async (_db, _cid, _turn, _text, ingestOpts) => {
          seenIngestCanonicality = ingestOpts.canonicality;
          return { writes: [], flags: [] };
        },
      });
      expect(result.gaps).toEqual([]);
      for (const layer of [result.contract.canonical, result.contract.active]) {
        expect(layer.canonicality.timeline_mode).toBe("inspired");
        expect(layer.canonicality.canon_cast_mode).toBe("npcs_only");
      }
      // Both consumption points share ONE derivation — the gate was handed the
      // same forced pair the contract stored.
      expect(seenIngestCanonicality).toEqual({
        timeline_mode: "inspired",
        canon_cast_mode: "npcs_only",
      });
      // event_fidelity is NOT forced: fidelity to the events the player
      // asserted about their OWN world is coherent, and theirs to set.
      expect(result.contract.active.canonicality.event_fidelity).toBe("background");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, stubId));
    }
  });

  it("a failed synthesis fails the compile LOUDLY — no default world, no stub row, campaign re-draftable", async () => {
    if (!db) throw new Error("unreachable");
    const { campaign, stubId } = await compileOriginal("original world failure fixture", {
      failWorldCall: true,
    });
    try {
      // v3's _default_creative_fields is deliberately NOT carried: a generic
      // fallback world is "generic output is useless" institutionalized.
      await expect(
        compileSessionZero(db, campaign.id, {
          ospSynthesizer: async () => {
            throw new Error("the OSP must never run without a world");
          },
          ingestor: async () => ({ writes: [], flags: [] }),
        }),
      ).rejects.toThrow(/original world synthesis boom/);

      const rows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, stubId));
      expect(rows).toHaveLength(0);
      const [row] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaign.id));
      // The claim reverted: the player re-proposes and buys the call again.
      expect(row?.status).toBe("draft");
      expect(row?.premiseContract).toBeNull();
      const facts = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, campaign.id));
      expect(facts).toHaveLength(0);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, stubId));
    }
  });

  it("a table with no anchor and no original-world word still HALTS at the compile (unchanged)", async () => {
    if (!db) throw new Error("unreachable");
    const anchorless: ConductorDraft = {
      transcript: [],
      observations: SCRIPTED_OBSERVATIONS,
      profileIds: [],
      readyToCompile: true,
    };
    const [blocked] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "anchorless fixture", status: "draft", szTranscript: anchorless })
      .returning();
    if (!blocked) throw new Error("insert failed");
    mockJudgment.mockReset();
    try {
      const result = await compileSessionZero(db, blocked.id, {
        ospSynthesizer: async () => {
          throw new Error("the OSP must never run on a gapped draft");
        },
      });
      expect(result.gaps.some((g) => g.includes("no researched profile"))).toBe(true);
      // No world was synthesized to paper over the hole.
      expect(mockJudgment).not.toHaveBeenCalled();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.id, `original_${blocked.id}`));
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, blocked.id));
    }
  });

  it("gap verdict blocks a sparkless handoff (§8)", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "spark")),
      true,
    );
    expect(gaps.some((g) => g.includes("spark"))).toBe(true);
  });

  it("a sparkless compile HALTS: campaign stays draft, nothing persists", async () => {
    if (!db) throw new Error("unreachable");
    const sparkless: ConductorDraft = {
      transcript: [],
      observations: SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "spark"),
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [blocked] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "sparkless fixture", status: "draft", szTranscript: sparkless })
      .returning();
    if (!blocked) throw new Error("insert failed");
    try {
      const result = await compileSessionZero(db, blocked.id, {
        ospSynthesizer: async () => {
          throw new Error("OSP must never run on a gapped draft");
        },
      });
      expect(result.gaps.length).toBeGreaterThan(0);
      const [row] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, blocked.id));
      expect(row?.status).toBe("draft");
      expect(row?.premiseContract).toBeNull();
      const facts = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, blocked.id));
      expect(facts).toHaveLength(0);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, blocked.id));
    }
  });

  it("compiles the scripted draft: contract + OSP persisted, handoff complete", async () => {
    if (!db) throw new Error("unreachable");
    // The C6 rebind (§5.4): SZ facts flow through the SAME ingestion seam as
    // gameplay. Stubbed here; its clarify must land in the OSP's deferred
    // context (an unanswerable question becomes an uncertainty, not silence).
    const ingestCalls: { text: string; provenance?: string; profileIds: string[] }[] = [];
    let ospDeferred: string[] = [];
    const result = await compileSessionZero(db, campaignId, {
      ingestor: async (_db, _cid, turnNumber, text, opts) => {
        expect(turnNumber).toBe(0);
        ingestCalls.push({ text, provenance: opts.provenance, profileIds: opts.profileIds });
        return {
          writes: [{ kind: "semantic_fact", id: "x", summary: "stubbed" }],
          clarify: "does the trawler have grav-plating?",
          flags: ["tier-inflation watch: 'best pilot in the system'"],
        };
      },
      ospSynthesizer: async (input) => {
        ospDeferred = [...input.resolved.playerDeferred];
        return STUB_OSP;
      },
    });
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]?.text).toContain("fishing trawler");
    expect(ingestCalls[0]?.provenance).toBe("sz_compiler");
    expect(ingestCalls[0]?.profileIds).toContain("test_sz_profile");
    expect(ospDeferred.some((d) => d.includes("grav-plating"))).toBe(true);
    expect(ospDeferred.some((d) => d.includes("tier-inflation"))).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.contract.spark).toContain("whatever happens");
    expect(result.contract.active.treatment.darkness).toBe(8); // player's move
    expect(result.contract.canonical.treatment.darkness).toBe(7); // profile untouched
    // SV3 no-regression: a tier-less draft compiles with NO pc_power_tier —
    // layout falls back to the world baseline exactly as before.
    expect(result.contract.pc_power_tier).toBeUndefined();
    expect(result.contract.intensity.hard_lines).toContain("no harm to children on-screen");
    // M3-DG: the structured device grant rides the contract, prose grant intact.
    expect(result.contract.presentation_vocabulary.directives).toContainEqual({
      name: "readout",
      skin: "the bounty terminal",
    });
    expect(result.contract.presentation_vocabulary.grants).toContain(
      "bare prose; episode-title cards only",
    );

    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(campaign?.status).toBe("active");
    expect(campaign?.tierModels).toMatchObject({ narration: "claude-sonnet-5" });

    const facts = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(facts.some((f) => f.content.includes("Finitude: finite"))).toBe(true);
    expect(facts.some((f) => f.content.startsWith("HARD LINE"))).toBe(true);
    // Player assertions persist deterministically — never via the OSP model.
    const trawler = facts.find((f) => f.content.includes("fishing trawler"));
    expect(trawler?.provenance).toBe("player_assertion");
    expect(trawler?.category).toBe("sz_fact");

    // A second compile must lose the draft→active race, not double-write.
    await expect(
      compileSessionZero(db, campaignId, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      }),
    ).rejects.toThrow(/already active/);
    const factsAfter = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(factsAfter).toHaveLength(facts.length);

    const marks = await db
      .select()
      .from(schema.pencilMarks)
      .where(eq(schema.pencilMarks.campaignId, campaignId));
    expect(marks.some((m) => m.topic === "spark")).toBe(true);

    const admitted = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.campaignId, campaignId));
    expect(admitted.some((e) => e.name === "The Trawler")).toBe(true);

    // SZ admission is a minting authority: creation writes version 1 so the
    // rewind block-restore always has a base (C6 re-audit — an unversioned
    // mint leaves the block unrestorable once later enrichments tombstone).
    const trawlerEntity = admitted.find((e) => e.name === "The Trawler");
    const trawlerVersions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, trawlerEntity?.id ?? ""));
    expect(trawlerVersions).toHaveLength(1);
    expect(trawlerVersions[0]?.version).toBe(1);
    expect(trawlerVersions[0]?.block).toBe(trawlerEntity?.block);

    const [player] = await db.select().from(schema.players).where(eq(schema.players.id, playerId));
    expect((player?.profile as { taste?: string[] }).taste?.[0]).toContain("found-family");
  });

  it("the compiled contract renders a Settei — the round-trip into C1", async () => {
    if (!db) throw new Error("unreachable");
    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const contract = campaign?.premiseContract as Parameters<typeof renderSettei>[0]["contract"];
    const settei = renderSettei({ contract, marks: [] });
    expect(settei.charterTokens).toBeGreaterThan(0);
    expect(settei.text).toContain("whatever happens");
    expect(settei.renderedAxes).toContain("darkness");
  });

  it("the compile claim is exclusive: a live 'compiling' blocks, a stale one re-claims", async () => {
    if (!db) throw new Error("unreachable");
    // Simulate a compile in flight: the claim was stamped moments ago.
    await db
      .update(schema.campaigns)
      .set({ status: "compiling", updatedAt: new Date() })
      .where(eq(schema.campaigns.id, campaignId));
    await expect(
      compileSessionZero(db, campaignId, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      }),
    ).rejects.toThrow(/already in flight/);
    // The loser lost BEFORE any side effect — it must NOT have reverted the
    // winner's claim (the C6 re-audit sabotage mode: a loser's catch flipping
    // compiling→draft fails the winner's own compiling→active transaction).
    const [held] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(held?.status).toBe("compiling");

    // A CRASHED compile (stale claim, no process left to revert it) stays
    // retryable: past the staleness window the claim is taken over.
    await db
      .update(schema.campaigns)
      .set({ updatedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(schema.campaigns.id, campaignId));
    const result = await compileSessionZero(db, campaignId, {
      ospSynthesizer: async () => STUB_OSP,
      ingestor: async () => ({ writes: [], flags: [] }),
    });
    expect(result.gaps).toEqual([]);
    const [after] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(after?.status).toBe("active");
  });
});
