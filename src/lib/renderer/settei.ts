import { approxTokens } from "@/lib/blocks/tokens";
import { loadGrounding } from "@/lib/rules/grounding";
import { guidanceFor } from "@/lib/rules/guidance";
import { DNAScales } from "@/lib/types/dna";
import { type AxisName, COVERED_AXES } from "@/lib/types/grounding";
import { type PencilMark, activeMarks } from "@/lib/types/marks";
import type { PremiseContract } from "@/lib/types/premise";

/**
 * The Settei renderer (§4.4a): compiles the premise into Block 1's durable
 * prose pressure. Deterministic assembly — the Renderer is a compiler
 * (axiom 7), never a model call. Numbers are for measurement; prose is for
 * pressure.
 *
 * Composition, in order: hard-core preamble (world rules + canonicality —
 * axiom 3's commands) → identity paragraph → the spark (standing note, §8
 * reader #1) → ≤6 extreme axes as craft instruction → 2–3 exemplar
 * passages for the most extreme covered axes → one line per non-extreme
 * axis group → Voice fingerprint verbatim → standing pencil marks.
 *
 * Regeneration triggers are the caller's law (§4.4a): session open,
 * premise edit, batched session-boundary changes — nothing else.
 */

export const SETTEI_MAX_RENDERED_AXES = 6;
export const SETTEI_MAX_EXEMPLARS = 3;
export const SETTEI_TOKEN_TARGET = { min: 600, max: 900 };

/** DNAScales key order — the deterministic tiebreak for equal distances. */
const AXIS_ORDER = Object.keys(DNAScales.shape) as AxisName[];
const AXIS_NAME_SET = new Set<string>(AXIS_ORDER);

/**
 * Learned shading (§12, §6.6): calibration vocabulary → the axis it implicates.
 * A standing mark whose topic/direction names or clearly implicates an axis
 * lifts that axis's SELECTION rank in the Settei — RENDER-TIME ONLY; the
 * contract and the marks themselves are never touched (§6.6: shade, never
 * mutate). Deliberately small and conservative — 2–4 keywords per axis, and a
 * miss (no boost) is the safe default; a false boost is the only real cost.
 * Keywords with a space or hyphen match as a phrase (substring); a bare stem
 * matches a whole token by prefix, so "restrain" catches "restraint" /
 * "restrained" without firing inside unrelated words.
 */
const AXIS_LEXICON: Partial<Record<AxisName, string[]>> = {
  emotional_register: ["understat", "restrain", "muted", "overwrought"],
  comedy: ["banter", "levity", "comedic", "slapstick"],
  darkness: ["grimdark", "bleak", "morbid"],
  cruelty: ["cruel", "brutal", "sadis", "merciless"],
  intimacy: ["intimac", "tender", "closeness"],
  interiority: ["introspect", "monologue", "interiori"],
  pacing: ["brisk", "breakneck", "languid"],
  register: ["ornate", "elevated", "vernacular", "lyrical"],
  optimism: ["hopeful", "cynic", "nihilis"],
  epistemics: ["myster", "cryptic", "withhold"],
  moral_complexity: ["ambiguit", "morally", "moral gray", "moral grey"],
  didacticism: ["didactic", "preachy", "moraliz"],
  agency: ["fatalis", "helpless", "proactive"],
  scope: ["cosmic", "galactic", "world-ending"],
  conflict_style: ["tactical", "instinctiv", "strategic"],
  density: ["layered", "subplot", "interwoven"],
  empathy: ["empath", "sympathet", "compassion"],
  fidelity: ["stylized", "absurdis", "photoreal"],
  avant_garde: ["experimental", "avant", "surreal"],
  temporal_structure: ["flashback", "nonlinear", "time loop"],
  continuity: ["serializ", "standalone", "episodic"],
  reflexivity: ["fourth wall", "self-aware", "metafiction"],
  accessibility: ["accessible", "beginner", "hand-holding"],
  power_treatment: ["cost of power", "hollow victory", "pyrrhic"],
};

const EMPTY_SHADE: ReadonlySet<AxisName> = new Set();

/**
 * The axes a set of standing marks implicates (learned shading, §12). Two
 * signals: an axis-kind mark whose topic IS an axis name (the Sakkan's own
 * writer #3), and lexicon keywords found in a mark's topic/direction prose.
 * Read-only — computes a rank boost, never a mutation.
 */
export function shadedAxes(marks: PencilMark[]): Set<AxisName> {
  const shaded = new Set<AxisName>();
  for (const m of activeMarks(marks)) {
    if (AXIS_NAME_SET.has(m.topic)) shaded.add(m.topic as AxisName);
    const text = `${m.topic} ${m.direction}`.toLowerCase();
    const tokens = text.split(/[^a-z]+/).filter(Boolean);
    for (const [axis, keywords] of Object.entries(AXIS_LEXICON) as [AxisName, string[]][]) {
      if (shaded.has(axis)) continue;
      const hit = keywords.some((kw) =>
        kw.includes(" ") || kw.includes("-")
          ? text.includes(kw)
          : tokens.some((t) => t.startsWith(kw)),
      );
      if (hit) shaded.add(axis);
    }
  }
  return shaded;
}

const AXIS_GROUPS: Record<string, AxisName[]> = {
  "tempo and structure": ["pacing", "continuity", "density", "temporal_structure"],
  "emotional valence": ["optimism", "darkness", "comedy", "emotional_register", "intimacy"],
  "realism and form": ["fidelity", "reflexivity", "avant_garde"],
  "morals and knowledge": ["epistemics", "moral_complexity", "didacticism", "cruelty"],
  "power and stakes": ["power_treatment", "scope", "agency"],
  "focus and style": ["interiority", "conflict_style", "register"],
  "reader relationship": ["empathy", "accessibility"],
};

export interface SetteiInput {
  contract: PremiseContract;
  /** Standing marks (Learned reader #1) — rendered, never mutated (§6.6). */
  marks: PencilMark[];
  /** Director-supplied secondary ranking; absent until C7 wires it (stubbed per plan). */
  arcRelevance?: Partial<Record<AxisName, number>>;
}

export interface Settei {
  text: string;
  renderedAxes: AxisName[];
  /**
   * Premise extremes excluded from rendering by the gap rule — the caller
   * must surface these (they demand grounding authorship, not silence).
   */
  uncoveredExtremes: AxisName[];
  exemplarIds: string[];
  /** Whole Block-1 artifact (§5.1: identity + Charter + world rules). */
  tokens: number;
  /**
   * The Style Charter's pressure sections only — §4.4a's ~600–900 budget
   * governs THIS number; the world-rules command block (axiom 3) is Block-1
   * freight outside the charter budget.
   */
  charterTokens: number;
  /** Trims applied to hold the §4.4a budget — surfaced, never silent. */
  trims: string[];
}

export function extremeAxes(treatment: DNAScales): AxisName[] {
  return AXIS_ORDER.filter((a) => treatment[a] <= 3 || treatment[a] >= 7);
}

/** Rank: shaded first → |distance from 5| desc → arcRelevance desc → schema order. */
export function rankAxes(
  treatment: DNAScales,
  axes: AxisName[],
  arcRelevance: Partial<Record<AxisName, number>> = {},
  shaded: ReadonlySet<AxisName> = EMPTY_SHADE,
): AxisName[] {
  return [...axes].sort((a, b) => {
    // Learned shading (§12): a mark-implicated axis wins the primary tier, so a
    // shaded extreme is lifted into the ≤6 window even from rank 7-8 (something
    // else drops — prescription budget, axiom 4). Player calibration is a strong
    // signal (§6.6); inside each tier the premise's strongest pressure still leads.
    const sh = (shaded.has(b) ? 1 : 0) - (shaded.has(a) ? 1 : 0);
    if (sh !== 0) return sh;
    const d = Math.abs(treatment[b] - 5) - Math.abs(treatment[a] - 5);
    if (d !== 0) return d;
    const r = (arcRelevance[b] ?? 0) - (arcRelevance[a] ?? 0);
    if (r !== 0) return r;
    return AXIS_ORDER.indexOf(a) - AXIS_ORDER.indexOf(b);
  });
}

/**
 * The v3 guidance chunks are teaching paragraphs; the Settei wants
 * directives (prescription budget, axiom 4). Clip to the first two
 * sentences — the instruction and its caveat — deterministically.
 */
function clipGuidance(guidance: string, sentences: number): string {
  const flat = guidance.replace(/\s+/g, " ").trim();
  const parts = flat.match(/[^.!?]+[.!?]+(\)|")?/g) ?? [flat];
  return parts.slice(0, sentences).join(" ").trim();
}

function craftInstruction(axis: AxisName, value: number, sentences: number): string {
  const band = value <= 3 ? "1" : "10";
  const guidance = guidanceFor(axis, band);
  const header = `${axis} = ${value}/10`;
  return guidance ? `**${header}.** ${clipGuidance(guidance, sentences)}` : `**${header}.**`;
}

export function renderSettei(input: SetteiInput): Settei {
  const { contract } = input;
  const treatment = contract.active.treatment;
  const world = contract.active.world;
  const voice = contract.active.voice;
  const canonicality = contract.active.canonicality;
  const trims: string[] = [];

  // Hard core (axiom 3): commands, before any advisory pressure.
  const hardCore: string[] = ["## World rules and canon (commands, not suggestions)"];
  if (world.power_system) {
    hardCore.push(
      `Power system — ${world.power_system.name}: ${world.power_system.mechanics} HARD LIMITS: ${world.power_system.limitations}`,
    );
  }
  hardCore.push(
    `Canonicality: timeline is ${canonicality.timeline_mode}; canon cast ${canonicality.canon_cast_mode}; canon events ${canonicality.event_fidelity}.`,
  );
  for (const line of canonicality.forbidden_contradictions) {
    hardCore.push(`NEVER contradict: ${line}`);
  }
  for (const line of canonicality.accepted_divergences) {
    hardCore.push(`Accepted divergence (player-blessed): ${line}`);
  }
  // The control key (§7.5): loss of control is a stake ONLY the player cuts, at
  // SZ, as a composition choice. When cut, the KA earns a BOUNDED permission —
  // the declared circumstance, kept brief, framed by the inviolable default.
  // When NO key exists, NOTHING renders: absolute agency is the standing law,
  // never a stated rule (§7.5 — no key exists unless the player cuts it).
  const controlKey = contract.intensity.control_key;
  if (controlKey) {
    hardCore.push(
      `Control key (player-cut, §7.5): in the declared circumstance — ${controlKey.circumstances}${controlKey.notes ? ` (${controlKey.notes})` : ""} — the player character may briefly slip the player's control; narrate that loss of agency, kept short and bounded to exactly this circumstance. Outside it the player's agency is absolute and inviolable; /meta re-opens the dialectic and /override melts the key instantly.`,
    );
  }

  const identity = [
    "## What this story is",
    `A ${world.world_setting.genre.join(", ")} story. ${voice.director_personality}`,
    `The spark — the player's own words, the moment this campaign exists to multiply: "${contract.spark}"`,
  ];

  // Gap rule (plan C1): no code path presses an ungrounded axis — craft
  // pressure included, not just exemplars. Uncovered extremes are surfaced
  // loudly so the gap-rule authoring can fire; they are never silently cut.
  // Learned shading (§12): standing marks lift the axes they implicate ahead of
  // the ≤6 cut and, downstream, ahead in the exemplar pick (which walks this
  // ranked order) — render-time only; input.marks and the contract are untouched.
  const shaded = shadedAxes(input.marks);
  const ranked = rankAxes(treatment, extremeAxes(treatment), input.arcRelevance, shaded);
  const uncoveredExtremes = ranked.filter((a) => !COVERED_AXES.includes(a));
  const rendered = ranked
    .filter((a) => COVERED_AXES.includes(a))
    .slice(0, SETTEI_MAX_RENDERED_AXES);
  const craftSentences = rendered.map(() => 2);
  const buildCraft = () => [
    "## The register (strongest pressures first)",
    ...rendered.map((axis, i) => craftInstruction(axis, treatment[axis], craftSentences[i] ?? 2)),
  ];
  let craft = buildCraft();

  // Exemplars: the most extreme rendered axes that have covered passages at
  // the matching band (gap rule: uncovered axes render craft text only).
  const { byId, anchors } = loadGrounding();
  const exemplarIds: string[] = [];
  const exemplarBlocks: string[] = ["## Register exemplars (write like this feels)"];
  for (const axis of rendered) {
    if (exemplarIds.length >= SETTEI_MAX_EXEMPLARS) break;
    if (!COVERED_AXES.includes(axis)) continue;
    const band = treatment[axis] <= 3 ? "1" : "9";
    const ref = anchors.find((a) => a.axis === axis)?.bands[band]?.excerpt_ref;
    const exemplar = ref ? byId.get(ref) : undefined;
    if (!exemplar) continue;
    exemplarIds.push(exemplar.id);
    exemplarBlocks.push(
      `(${axis} at the ${band === "1" ? "low" : "high"} extreme)\n${exemplar.text}`,
    );
  }

  // §4.4a: one line per NON-EXTREME axis group. Unrendered extremes are
  // left unmentioned — telling the KA to keep a premise extreme "moderate"
  // would press AGAINST the premise (C1 audit, blocking). The prescription
  // budget means some true extremes go unpressed; it never means they get
  // counter-pressed.
  const groupLines = ["## Everything else stays centered"];
  for (const [group, axes] of Object.entries(AXIS_GROUPS)) {
    const mid = axes.filter((a) => treatment[a] > 3 && treatment[a] < 7);
    if (mid.length === 0) continue;
    groupLines.push(`${group}: keep ${mid.join(", ")} moderate, unforced.`);
  }

  const voiceBlock = [
    "## Voice fingerprint (verbatim)",
    `Sentence patterns: ${voice.author_voice.sentence_patterns.join("; ")}`,
    `Structural motifs: ${voice.author_voice.structural_motifs.join("; ")}`,
    `Dialogue quirks: ${voice.author_voice.dialogue_quirks.join("; ")}`,
    `Emotional rhythm: ${voice.author_voice.emotional_rhythm.join("; ")}`,
    `In-register sample: ${voice.author_voice.example_voice}`,
    `Cast depth: main cast ${voice.cast_depth_posture.main_cast}; supporting ${voice.cast_depth_posture.supporting}; bits ${voice.cast_depth_posture.recurring_bits}.`,
  ];

  const standing = activeMarks(input.marks);
  const marksBlock =
    standing.length === 0
      ? []
      : [
          "## Standing calibration (learned from this player, this campaign)",
          ...standing.map((m) => `- ${m.topic}: ${m.direction}`),
        ];

  const assemble = (sections: string[][]) =>
    sections
      .filter((s) => s.length > 1 || (s.length === 1 && !s[0]?.startsWith("##")))
      .map((s) => s.join("\n\n"))
      .join("\n\n");
  const buildCharter = () =>
    assemble([identity, craft, exemplarBlocks, groupLines, voiceBlock, marksBlock]);

  let charter = buildCharter();
  // Budget, stage 1: trim exemplars last-in-first-out (floor: 2, per
  // §4.4a's "2–3") — craft instructions are the load-bearing pressure.
  while (approxTokens(charter) > SETTEI_TOKEN_TARGET.max && exemplarIds.length > 2) {
    const droppedId = exemplarIds.pop();
    exemplarBlocks.pop();
    trims.push(`exemplar ${droppedId} dropped for budget`);
    charter = buildCharter();
  }
  // Stage 2: clip craft guidance to one sentence, least-extreme axis first
  // — the strongest pressures keep their caveats longest.
  for (
    let i = rendered.length - 1;
    i >= 0 && approxTokens(charter) > SETTEI_TOKEN_TARGET.max;
    i--
  ) {
    craftSentences[i] = 1;
    trims.push(`craft guidance for ${rendered[i]} clipped to one sentence`);
    craft = buildCraft();
    charter = buildCharter();
  }

  if (approxTokens(charter) > SETTEI_TOKEN_TARGET.max) {
    trims.push(`charter still over budget after all trims: ${approxTokens(charter)} tokens`);
  }

  const text = `${assemble([hardCore])}\n\n${charter}`;
  return {
    text,
    renderedAxes: rendered,
    uncoveredExtremes,
    exemplarIds,
    tokens: approxTokens(text),
    charterTokens: approxTokens(charter),
    trims,
  };
}
