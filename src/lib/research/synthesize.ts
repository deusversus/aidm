/**
 * Research synthesis calls (blueprint §4.6; v3 anime_research.py order
 * carried): interpretation (tonal + framing, anchored to community tags
 * AND the C6 witness shows) → power system (if technique pages) → voice
 * cards → narrative synthesis LAST, under the standing test — "every
 * sentence should be something that could NOT apply to a different anime"
 * — and gated by the live NAA judge before it enters the profile.
 */

import { LOOPED_LARGE, STRUCTURED_RICH, STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { loadGrounding } from "@/lib/rules/grounding";
import { Composition } from "@/lib/types/composition";
import { DNAScales } from "@/lib/types/dna";
import { COVERED_AXES } from "@/lib/types/grounding";
import { CastDepthPosture } from "@/lib/types/premise";
import {
  AuthorVoice,
  CombatStyle,
  PowerDistribution,
  PowerSystem,
  StatMapping,
  StorytellingTropes,
  VisualStyle,
  VoiceCard,
} from "@/lib/types/profile";
import { z } from "zod";
import type { AniListMedia } from "./anilist";
import { relevantTags } from "./anilist";
import type { CanonicalPageType, WikiPage } from "./wiki";

/**
 * The research pin: quality above Haiku, never Fable (Fable exists only on
 * the narration menu). Exported for websearch.ts (M3R3 C2) — the fallback
 * chain's search + shaping calls run the same tier as every synthesis call.
 */
export const RESEARCH_SELECTION = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" as const };
const SELECTION = RESEARCH_SELECTION;

function witnessAnchorBlock(): string {
  const { anchors } = loadGrounding();
  return COVERED_AXES.map((axis) => {
    const a = anchors.find((x) => x.axis === axis);
    if (!a) return `- ${axis}`;
    const line = (band: "1" | "5" | "9") => a.bands[band].shows.map((s) => s.title).join(", ");
    return `- ${axis} (${a.scale}): 1≈[${line("1")}] 5≈[${line("5")}] 9≈[${line("9")}]`;
  }).join("\n");
}

// --- 1. Interpretation: canonical Treatment + Framing ----------------------

export interface TonalInterpretation {
  treatment: z.infer<typeof DNAScales>;
  framing: z.infer<typeof Composition>;
  combat_style: z.infer<typeof CombatStyle>;
  power_distribution: z.infer<typeof PowerDistribution>;
  storytelling_tropes: z.infer<typeof StorytellingTropes>;
  visual_style: z.infer<typeof VisualStyle>;
}

function mediaBlock(media: AniListMedia): string {
  const tags = relevantTags(media)
    .map((t) => `${t.name} (${t.rank}%)`)
    .join(", ");
  return [
    `Title: ${media.title.english ?? media.title.romaji}`,
    `Format: ${media.format} · Episodes: ${media.episodes ?? "?"} · Score: ${media.averageScore ?? "?"}`,
    `Genres: ${media.genres.join(", ")}`,
    `Community tags: ${tags}`,
    `Synopsis: ${(media.description ?? "").slice(0, 1_500)}`,
  ].join("\n");
}

/**
 * Excerpt selection for the TONAL read (M3R3 C3, lesson L3). Priority is that
 * read's need, not the wiki's shape: lore and arcs carry HOW the story is
 * told; characters, places and factions carry who and where; techniques and
 * items are the most mechanical and the least tonal, so they fill only what
 * the rest leave.
 *
 * The grounding pass does NOT read this block. Its ranking is the tonal
 * read's, so an eight-page cap over a rich harvest could exclude the technique
 * pages a power-system claim was synthesized FROM — and an auditor told
 * "when in doubt, unsupported" then demotes a genuinely sourced claim by
 * construction. Grounding carries its own per-claim evidence instead.
 */
const EXCERPT_PRIORITY: CanonicalPageType[] = [
  "lore",
  "arcs",
  "characters",
  "locations",
  "factions",
  "techniques",
  "items",
];
const EXCERPT_MAX_PAGES = 8;
const EXCERPT_PAGE_CHARS = 600;
const EXCERPT_BLOCK_CHARS = 5_000;

/**
 * Up to eight pages of fetched text, priority-ordered, each clipped to its
 * opening — the lead of a wiki or research page is where the work is actually
 * characterised; deeper sections are episode tables and trivia.
 */
export function sourceExcerptBlock(pages: WikiPage[]): string {
  if (pages.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  const ranked = pages
    .map((page, index) => ({ page, index, rank: EXCERPT_PRIORITY.indexOf(page.pageType) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, EXCERPT_MAX_PAGES);
  for (const { page } of ranked) {
    const entry = `## [${page.pageType}] ${page.title}\n${page.text.slice(0, EXCERPT_PAGE_CHARS)}`;
    if (used + entry.length > EXCERPT_BLOCK_CHARS) break;
    parts.push(entry);
    used += entry.length + 2;
  }
  return parts.join("\n\n");
}

const INTERPRET_SYSTEM = [
  "You score a source work's canonical fingerprint for a story engine.",
  "The AniList tags are the PRIMARY signal — they are community-voted",
  "relevance percentages. Judge the work, not your affection for it.",
].join(" ");

/**
 * L3's correction, stated to the model: the synopsis is a marketing blurb and
 * recall is unverifiable, so where the fetched pages speak, they win.
 */
const GROUNDED_INTERPRET_SENTENCE =
  "Where the FETCHED SOURCE EXCERPTS conflict with the synopsis or with your own recollection of this work, the EXCERPTS win — the synopsis is promotional copy and the excerpts are the record.";

/**
 * Split into three strict-output calls: the combined schema (24 axes + 13
 * enums + 15 tropes + distributions) compiles to a grammar the API rejects
 * as too large. Same tokens, three small grammars.
 *
 * `pages` closes lesson L3, the plan's deepest finding: this call read ONLY
 * the AniList synopsis block, so a profile's canonical DNA, framing, tropes
 * and visual style were model recall BY CONSTRUCTION — even when the run had
 * scraped a rich wiki, and even for a post-cutoff adaptation recall cannot
 * know. Default empty so a caller with no harvest is honest by shape.
 */
export async function interpretTonal(
  media: AniListMedia,
  pages: WikiPage[] = [],
): Promise<TonalInterpretation> {
  const excerpts = sourceExcerptBlock(pages);
  const block = excerpts
    ? `${mediaBlock(media)}\n\nFETCHED SOURCE EXCERPTS (ground your scores in these where they speak; the synopsis is a blurb, these are the record):\n${excerpts}`
    : mediaBlock(media);
  const interpretSystem = excerpts
    ? `${INTERPRET_SYSTEM} ${GROUNDED_INTERPRET_SENTENCE}`
    : INTERPRET_SYSTEM;
  const [treatmentPart, framingPart, worldPart] = await Promise.all([
    callJudgment(SELECTION, {
      name: "research_interpret_treatment",
      phase: "research",
      schema: z.object({ treatment: DNAScales }),
      system: `${interpretSystem} Calibrate the 0-10 treatment axes against these witness anchors (same scales the engine measures with):\n${witnessAnchorBlock()}`,
      prompt: block,
      effort: "high",
      maxTokens: LOOPED_LARGE,
    }),
    callJudgment(SELECTION, {
      name: "research_interpret_framing",
      phase: "research",
      schema: z.object({
        framing: Composition,
        combat_style: CombatStyle,
        power_distribution: PowerDistribution,
      }),
      system: [
        interpretSystem,
        "Framing enums describe how the source is NATURALLY told — structure,",
        "not tone. combat_style describes the PROTAGONIST'S DECISION PROCESS",
        "and what fights are FOR — never how the camera dresses them (stylish",
        "or extended choreography does NOT make spectacle): tactical = the",
        "fighter assesses, plans, counters, exploits information — even when",
        "the execution looks spectacular; spectacle = the showcase IS the",
        "point and the fighter's process is thin (rule of cool decides);",
        "comedy = fights resolve as gags; spirit = willpower and feeling",
        "decide outcomes; narrative = fights exist to advance story and",
        "character — typically brief, always consequential, never the main",
        "course.",
      ].join(" "),
      prompt: block,
      effort: "high",
      maxTokens: STRUCTURED_RICH,
    }),
    callJudgment(SELECTION, {
      name: "research_interpret_world",
      phase: "research",
      schema: z.object({
        storytelling_tropes: StorytellingTropes,
        visual_style: VisualStyle,
      }),
      system: `${interpretSystem} Trope flags are structural facts about the source; visual style feeds reference conditioning later — be concrete.`,
      prompt: block,
      effort: "low",
      maxTokens: STRUCTURED_RICH,
    }),
  ]);
  return {
    treatment: treatmentPart.treatment,
    framing: framingPart.framing,
    combat_style: framingPart.combat_style,
    power_distribution: framingPart.power_distribution,
    storytelling_tropes: worldPart.storytelling_tropes,
    visual_style: worldPart.visual_style,
  };
}

// --- 2. Power system (only when technique pages exist) ----------------------

/**
 * What each source-fed synthesis call actually READS, by organ. The grounding
 * pass hands its auditor the SAME slice, by importing this — that is the whole
 * reason it is a constant rather than two inline literals.
 *
 * The re-audit's finding: the claim evidence was clipped to 3 pages × 800
 * chars while synthesizePowerSystem had read 5 × 1,000, so a power system
 * synthesized from technique pages 4-5 (or from chars 800-1,000 of pages 1-3)
 * met an auditor told "when in doubt, unsupported" against text that could not
 * contain it — a false demotion BY CONSTRUCTION, on exactly the rich harvests
 * where grounding matters most. Parity now holds by construction instead: the
 * two sides cannot drift without moving this one object.
 */
export const SYNTHESIS_FEEDS = {
  power_system: { pages: 5, chars: 1_000 },
  stat_mapping: { pages: 3, chars: 800 },
} as const;

/** The shape a caller needs to read a feed the way its synthesis call did. */
export interface SynthesisFeedSpec {
  pages: number;
  chars: number;
}

export async function synthesizePowerSystem(
  techniquePages: WikiPage[],
): Promise<z.infer<typeof PowerSystem>> {
  const feed = SYNTHESIS_FEEDS.power_system;
  const excerpts = techniquePages
    .slice(0, feed.pages)
    .map((p) => `## ${p.title}\n${p.text.slice(0, feed.chars)}`)
    .join("\n\n");
  return callJudgment(SELECTION, {
    name: "research_power_system",
    phase: "research",
    schema: PowerSystem,
    system:
      "Synthesize the source's power system from its technique pages. `limitations` is the field the engine enforces as HARD RULES — be precise about costs, triggers, and what the system cannot do.",
    prompt: excerpts,
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });
}

// --- 3. Voice cards ----------------------------------------------------------

/**
 * ≤8 cards, enforced in the prompt + below rather than by a schema bound: the
 * structured-output grammar strips maxItems (2026-08-01), so a `.max(8)` here
 * could not hold the model to eight — only fail the parse and take the whole
 * profile research run down with it (this call is awaited unguarded).
 */
const VOICE_CARDS_MAX = 8;
export const VoiceCards = z.object({ cards: z.array(VoiceCard) });

/**
 * The unattributed cast corpus (M2R4/M2R5 starvation, repaired M3R4 B3). A
 * SEARCHED characters page carries the whole cast under one synthetic title, so
 * it can never key a speaker and is rightly kept out of the quote block — but
 * M3R3 added that search topic precisely to harvest "personalities speech
 * patterns notable quotes catchphrases", and none of it reached the card
 * synthesis. A web-identity profile with no wiki and no AniList cast therefore
 * shipped an EMPTY voice organ while the material sat in the corpus. It rides
 * in here as prose, never as a speaker key.
 */
export const VOICE_CORPUS_FEED: SynthesisFeedSpec = { pages: 3, chars: 1_500 };

export async function synthesizeVoiceCards(
  quotesByCharacter: Record<string, string[]>,
  gapFillMainCast: string[],
  voiceCorpusPages: WikiPage[] = [],
): Promise<z.infer<typeof VoiceCard>[]> {
  const quoteBlock = Object.entries(quotesByCharacter)
    .slice(0, 8)
    .map(([name, quotes]) => `${name}:\n${quotes.map((q) => `  "${q}"`).join("\n")}`)
    .join("\n\n");
  const corpus = voiceCorpusPages
    .slice(0, VOICE_CORPUS_FEED.pages)
    .map((p) => p.text.slice(0, VOICE_CORPUS_FEED.chars))
    .join("\n\n");
  const result = await callJudgment(SELECTION, {
    name: "research_voice_cards",
    phase: "research",
    schema: VoiceCards,
    system: `Build voice cards for the main cast from wiki-sourced quotes. Where a main-cast member has no quotes, derive the card from what the quotes of OTHERS reveal plus the character's role — mark speech_patterns conservatively rather than inventing tics. CAST NOTES, when present, are unattributed prose about the cast gathered by search: read them for who these characters are and how they speak, but they are NOT a speaker — every card is named for a CHARACTER, never for the notes or their source. Emit at most ${VOICE_CARDS_MAX} cards, most central first — any beyond the eighth are discarded unread.`,
    prompt: [
      `Quotes:\n${quoteBlock || "(none)"}`,
      corpus ? `\n\nCast notes (unattributed prose):\n${corpus}` : "",
      `\n\nMain cast needing gap-fill: ${gapFillMainCast.join(", ") || "(none)"}`,
    ].join(""),
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });
  if (result.cards.length > VOICE_CARDS_MAX) {
    console.warn(
      `[research] voice cards over the ${VOICE_CARDS_MAX}-card ceiling — clamped, research kept`,
      { emitted: result.cards.length },
    );
  }
  return result.cards.slice(0, VOICE_CARDS_MAX);
}

// --- 4. Narrative synthesis (LAST) + NAA gate --------------------------------

export const NarrativeSynthesis = z.object({
  director_personality: z
    .string()
    .describe("3-5 sentences, second person, the IP-specific directing voice"),
  author_voice: AuthorVoice,
  cast_depth_posture: CastDepthPosture,
});
export type NarrativeSynthesis = z.infer<typeof NarrativeSynthesis>;

const NaaVerdict = z.object({
  ip_specific: z.boolean(),
  reasoning: z.string().describe("one or two sentences"),
});

/**
 * §10.6 gate over the voice outputs (director_personality AND the author-
 * voice sample). A FAIL verdict is confirmed by majority-of-3 — the same
 * doctrine the NAA eval suite uses; single-sample gating hard-failed
 * research runs on judge flakes (C2 audit).
 */
export async function naaGate(title: string, voiceText: string): Promise<boolean> {
  const judge = () =>
    callJudgment(SELECTION, {
      name: "research_naa_gate",
      phase: "research",
      schema: NaaVerdict,
      system:
        "Judge directing-voice text for a story engine. It passes only if every sentence is something that could NOT apply to a different anime — named-show specificity of craft, not generic 'balance humor and heart' advice.",
      prompt: `Claimed source: ${title}\n\n${voiceText}`,
      effort: "low",
      maxTokens: STRUCTURED_SMALL,
    });
  let fails = (await judge()).ip_specific ? 0 : 1;
  for (let i = 0; i < 2 && fails > 0 && fails < 2; i++) {
    if (!(await judge()).ip_specific) fails++;
  }
  return fails < 2;
}

export interface NarrativeContext {
  genres: string[];
  tags: string[];
  tropes: string[];
  voiceCardNames: string[];
  /** The assembled-profile payload v3's LAST position exists for (C2 audit). */
  treatment?: z.infer<typeof DNAScales>;
  combatStyle?: string;
  powerSystemSummary?: string;
  synopsis?: string;
}

export async function synthesizeNarrative(
  title: string,
  assembled: NarrativeContext,
  attempt = 0,
): Promise<NarrativeSynthesis> {
  const extremes = assembled.treatment
    ? Object.entries(assembled.treatment)
        .filter(([, v]) => v <= 3 || v >= 7)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
  const result = await callJudgment(SELECTION, {
    name: "research_narrative",
    phase: "research",
    schema: NarrativeSynthesis,
    system: [
      "You distill an IP's method-of-telling for a story engine's writer,",
      "grounded in the assembled profile below — sit on top of it, don't",
      "restate it. THE STANDING TEST: every sentence should be something that",
      "could NOT apply to a different anime. BAD (generic): 'Balance action",
      "with quieter character moments.' GOOD (IP-specific): 'End every bounty",
      "in a draw that costs more than the reward; let silence do the grieving",
      "the cast refuses to do out loud.' cast_depth_posture states, per tier,",
      "how much depth the source actually gives its cast — role-filling bits",
      "are a legitimate posture, not a defect.",
      attempt > 0 ? "PREVIOUS ATTEMPT FAILED the specificity gate — sharpen every sentence." : "",
    ].join(" "),
    prompt: [
      `Title: ${title}`,
      `Genres: ${assembled.genres.join(", ")}`,
      `Top tags: ${assembled.tags.slice(0, 15).join(", ")}`,
      `Tonal extremes: ${extremes || "(none scored)"}`,
      `Combat style: ${assembled.combatStyle ?? "(unknown)"}`,
      `Power system: ${assembled.powerSystemSummary ?? "(none)"}`,
      `Active tropes: ${assembled.tropes.join(", ") || "(none)"}`,
      `Main cast: ${assembled.voiceCardNames.join(", ") || "(unknown)"}`,
      `Synopsis: ${(assembled.synopsis ?? "").slice(0, 1_200)}`,
    ].join("\n"),
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });
  const gated = `${result.director_personality}\n\nVoice sample: ${result.author_voice.example_voice}`;
  if (!(await naaGate(title, gated))) {
    if (attempt >= 1) {
      throw new Error(`narrative synthesis failed the NAA gate twice for ${title}`);
    }
    return synthesizeNarrative(title, assembled, attempt + 1);
  }
  return result;
}

// --- Stat mapping (applied only at v3's confidence bar) ----------------------

export const DEFAULT_STAT_MAPPING: z.infer<typeof StatMapping> = {
  has_canonical_stats: false,
  confidence: 0,
  aliases: {},
  meta_resources: {},
  hidden: [],
  display_order: [],
};

export async function synthesizeStatMapping(
  title: string,
  lorePages: WikiPage[],
): Promise<z.infer<typeof StatMapping>> {
  if (lorePages.length === 0) return DEFAULT_STAT_MAPPING;
  const feed = SYNTHESIS_FEEDS.stat_mapping;
  const excerpts = lorePages
    .slice(0, feed.pages)
    .map((p) => `## ${p.title}\n${p.text.slice(0, feed.chars)}`)
    .join("\n\n");
  const result = await callJudgment(SELECTION, {
    name: "research_stat_mapping",
    phase: "research",
    schema: StatMapping,
    system:
      "Does this source have a CANONICAL on-screen stat system (status windows, hunter ranks with numbers, explicit levels)? If yes, map its stats onto D&D-style internals. If no, say has_canonical_stats=false with confidence 0 — most works have none, and inventing one is a defect.",
    prompt: `Title: ${title}\n\n${excerpts}`,
    effort: "low",
    maxTokens: STRUCTURED_RICH,
  });
  // v3's bar: apply only at ≥90 confidence; below it, the default stands.
  return result.has_canonical_stats && result.confidence >= 90 ? result : DEFAULT_STAT_MAPPING;
}

// --- The grounding pass (M3R3 C3) --------------------------------------------

/**
 * One claim the desk is about to ship, carrying the source text it was
 * synthesized FROM. `key` is the caller's own id — it comes back verbatim on
 * the verdict, so the caller can wire consequences without matching prose.
 *
 * `evidence` is per-claim, and that is the whole design: a single shared
 * excerpt block ranked for the tonal read (lore first, techniques sixth of
 * seven, hard-capped at eight pages) systematically excluded the pages each
 * claim came from, so the auditor judged a wiki-sourced power system against
 * text that structurally could not contain it — and its own "when in doubt,
 * unsupported" rule made that a guaranteed false demotion on the richest
 * harvests. Evidence now travels WITH the claim, clipped by SYNTHESIS_FEEDS —
 * the same object the synthesis call read its own feed through.
 */
export interface GroundingClaim {
  key: string;
  claim: string;
  evidence: string;
}

/**
 * The claims block: each claim immediately followed by its own evidence, so
 * the boundary the system prompt draws is visible in the text itself. Pure and
 * exported so the rendering is testable without buying a model call.
 */
export function renderClaims(claims: GroundingClaim[]): string {
  return claims
    .map((c) => `### CLAIM ${c.key}\n${c.claim}\n### EVIDENCE FOR ${c.key}\n${c.evidence}`)
    .join("\n\n");
}

/**
 * Enum-free by design: the schema cannot enumerate keys the caller builds at
 * runtime, and a grammar-level enum would fail the whole parse on a key the
 * model paraphrased. Unrecognised keys are dropped by the caller instead.
 */
export const GroundingVerdicts = z.object({
  verdicts: z.array(z.object({ key: z.string(), supported: z.boolean() })),
});
export type GroundingVerdicts = z.infer<typeof GroundingVerdicts>;

/**
 * The desk audits itself against its own harvest (M3R3 C3). Synthesis calls
 * are asked to produce an answer, and a model asked for a power system will
 * write one whether or not the sources carry it — that is exactly how the
 * founding profile shipped fluent recall at confidence 90. This call inverts
 * the question: given only the text that FED this claim, is it actually in
 * there?
 *
 * Verdicts do not delete anything the player can see (C4 owns that surgery);
 * they demote PROVENANCE — an unsupported claim stops being labeled as
 * sourced, and says so in the gap channel.
 */
export async function groundProfile(
  title: string,
  claims: GroundingClaim[],
): Promise<GroundingVerdicts> {
  return callJudgment(SELECTION, {
    name: "research_grounding",
    phase: "research",
    schema: GroundingVerdicts,
    system: [
      "You verify a research desk's claims against its own fetched sources.",
      "Each claim below carries its OWN evidence section. Judge a claim ONLY",
      "against the EVIDENCE FOR that claim — sources elsewhere in this run do",
      "not exist for it. supported=true ONLY when that evidence states or",
      "clearly implies the claim; its absence of comment is NOT support. When",
      "in doubt, unsupported. Return exactly one verdict per claim, echoing its",
      "key verbatim; never judge from what you remember about this work.",
    ].join(" "),
    prompt: [`Work: ${title}`, "", "CLAIMS TO VERIFY:", "", renderClaims(claims)].join("\n"),
    effort: "low",
    maxTokens: STRUCTURED_SMALL,
  });
}
