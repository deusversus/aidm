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
import type { WikiPage } from "./wiki";

const SELECTION = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" as const };

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

const INTERPRET_SYSTEM = [
  "You score a source work's canonical fingerprint for a story engine.",
  "The AniList tags are the PRIMARY signal — they are community-voted",
  "relevance percentages. Judge the work, not your affection for it.",
].join(" ");

/**
 * Split into three strict-output calls: the combined schema (24 axes + 13
 * enums + 15 tropes + distributions) compiles to a grammar the API rejects
 * as too large. Same tokens, three small grammars.
 */
export async function interpretTonal(media: AniListMedia): Promise<TonalInterpretation> {
  const block = mediaBlock(media);
  const [treatmentPart, framingPart, worldPart] = await Promise.all([
    callJudgment(SELECTION, {
      name: "research_interpret_treatment",
      schema: z.object({ treatment: DNAScales }),
      system: `${INTERPRET_SYSTEM} Calibrate the 0-10 treatment axes against these witness anchors (same scales the engine measures with):\n${witnessAnchorBlock()}`,
      prompt: block,
      effort: "high",
      maxTokens: LOOPED_LARGE,
    }),
    callJudgment(SELECTION, {
      name: "research_interpret_framing",
      schema: z.object({
        framing: Composition,
        combat_style: CombatStyle,
        power_distribution: PowerDistribution,
      }),
      system: [
        INTERPRET_SYSTEM,
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
      schema: z.object({
        storytelling_tropes: StorytellingTropes,
        visual_style: VisualStyle,
      }),
      system: `${INTERPRET_SYSTEM} Trope flags are structural facts about the source; visual style feeds reference conditioning later — be concrete.`,
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

export async function synthesizePowerSystem(
  techniquePages: WikiPage[],
): Promise<z.infer<typeof PowerSystem>> {
  const excerpts = techniquePages
    .slice(0, 5)
    .map((p) => `## ${p.title}\n${p.text.slice(0, 1_000)}`)
    .join("\n\n");
  return callJudgment(SELECTION, {
    name: "research_power_system",
    schema: PowerSystem,
    system:
      "Synthesize the source's power system from its technique pages. `limitations` is the field the engine enforces as HARD RULES — be precise about costs, triggers, and what the system cannot do.",
    prompt: excerpts,
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });
}

// --- 3. Voice cards ----------------------------------------------------------

const VoiceCards = z.object({ cards: z.array(VoiceCard).max(8) });

export async function synthesizeVoiceCards(
  quotesByCharacter: Record<string, string[]>,
  gapFillMainCast: string[],
): Promise<z.infer<typeof VoiceCard>[]> {
  const quoteBlock = Object.entries(quotesByCharacter)
    .slice(0, 8)
    .map(([name, quotes]) => `${name}:\n${quotes.map((q) => `  "${q}"`).join("\n")}`)
    .join("\n\n");
  const result = await callJudgment(SELECTION, {
    name: "research_voice_cards",
    schema: VoiceCards,
    system:
      "Build voice cards for the main cast from wiki-sourced quotes. Where a main-cast member has no quotes, derive the card from what the quotes of OTHERS reveal plus the character's role — mark speech_patterns conservatively rather than inventing tics.",
    prompt: `Quotes:\n${quoteBlock}\n\nMain cast needing gap-fill: ${gapFillMainCast.join(", ") || "(none)"}`,
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });
  return result.cards;
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
  const excerpts = lorePages
    .slice(0, 3)
    .map((p) => `## ${p.title}\n${p.text.slice(0, 800)}`)
    .join("\n\n");
  const result = await callJudgment(SELECTION, {
    name: "research_stat_mapping",
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
