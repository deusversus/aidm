import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import type { AuthorVoice } from "@/lib/types/profile";
import { z } from "zod";

/**
 * The §4.5 Voice checklist (M2R4) — the author's hand, MEASURED.
 *
 * The Gauge's axis half measures the REGISTER (the DNA dials, blind). This is
 * the other half §4.5 promised and never got built: a checklist judge that
 * audits the same stripped prose window against the contract's own author
 * fingerprint — the four dimensions of named patterns (sentence_patterns,
 * structural_motifs, dialogue_quirks, emotional_rhythm). Without it, voice
 * fidelity was unmeasured and therefore uncorrectable — "the tone is correct
 * for the DNA values Re:ZERO would have, but maybe not true to Re:ZERO itself"
 * (the M2R4 trigger).
 *
 * BLINDNESS LAW: this judge necessarily SEES the fingerprint — the fingerprint
 * IS the checklist. It must never see a DNA/treatment value, so the axis
 * scorer's blindness (score.ts) is untouched by its existence. The enforcement
 * is structural: buildVoiceChecklistPrompt accepts a VoicePatterns and a
 * sample string, and nothing else — there is no channel for a dial. The pin in
 * voice.test.ts asserts the built surface carries no dial vocabulary and no
 * n/10 value, the way attribution.test.ts pins the attribution probe.
 *
 * §4.5's letter asks for `{present: bool, evidence}` per feature; M2R4 grades
 * it 1–9 instead (the SakkanState seam types `score: number`). A boolean cannot
 * separate "the hand is gone" from "the hand is faint", and the pressure rule
 * needs a threshold to fire on — a graded read is strictly the richer artifact
 * and collapses to the boolean whenever anyone wants it.
 */

export const VOICE_DIMENSIONS = [
  "sentence_patterns",
  "structural_motifs",
  "dialogue_quirks",
  "emotional_rhythm",
] as const;
export type VoiceDimension = (typeof VOICE_DIMENSIONS)[number];

/**
 * The checklist's ONLY story input: the four named-pattern lists. No
 * `treatment`/`dna`/`active`/`wanted` channel exists here by design — the
 * blindness is enforced at the type level, so a dial cannot be smuggled into
 * the prompt. `example_voice` is deliberately NOT here either: the sample
 * paragraph anchors the PRESSURE line (composed in sakkan.ts), while the judge
 * checks named patterns — asking it to compare against one paragraph would
 * measure resemblance to a fragment instead of adherence to the hand.
 */
export type VoicePatterns = Record<VoiceDimension, string[]>;

/** The four pattern lists lifted off a contract's author_voice (example_voice dropped). */
export function voicePatterns(av: AuthorVoice): VoicePatterns {
  return {
    sentence_patterns: av.sentence_patterns,
    structural_motifs: av.structural_motifs,
    dialogue_quirks: av.dialogue_quirks,
    emotional_rhythm: av.emotional_rhythm,
  };
}

/** Dimensions that carry at least one named pattern — the only ones a checklist can check. */
export function measurableDimensions(patterns: VoicePatterns): VoiceDimension[] {
  return VOICE_DIMENSIONS.filter((d) => patterns[d].length > 0);
}

/**
 * The dimension a standing pressure line names, via the quoted-name convention
 * composeVoicePressure writes. The SINGLE derivation both consumers ride — the
 * sampler's clear logic and the trend's ×2 flag — so the line format and its
 * readers cannot drift apart.
 */
export function pressuredDimension(pressure: string | undefined): VoiceDimension | undefined {
  if (!pressure) return undefined;
  return VOICE_DIMENSIONS.find((d) => pressure.includes(`"${d}"`));
}

export const VoiceDimensionRead = z.object({
  /** One of VOICE_DIMENSIONS — echoed back so the reads key cleanly. */
  name: z.string(),
  /** 1 = the patterns are absent · 5 = intermittent/weakened · 9 = unmistakably this hand. */
  score: z.number().int().min(1).max(9),
  /** One short span: what carried the read, or where the pattern was expected and missing. */
  evidence: z.string(),
});
export type VoiceDimensionRead = z.infer<typeof VoiceDimensionRead>;

/**
 * Flat array, not a 4-tuple: native strict structured output is happiest with
 * a plain array of objects, so the "exactly four" contract is enforced in code
 * (the caller filters to the dimensions it asked about) rather than in the
 * schema. Same shape discipline as score.ts's ScoreSheet.
 */
const VoiceChecklistSheet = z.object({ dimensions: z.array(VoiceDimensionRead) });

export const VOICE_CHECKLIST_SYSTEM = [
  "You are the Sakkan's VOICE checklist for a prose story engine — the author's-hand",
  "read that sits beside the blind axis scoring. You are given ONE author's named prose",
  "patterns, grouped into dimensions, and a sample of prose written in that author's",
  "register. For each dimension, judge how strongly the sample exhibits THAT DIMENSION'S",
  "OWN named patterns: 1 means the patterns are absent (this prose could be anyone's),",
  "5 means they surface intermittently or in weakened form, 9 means the prose is",
  "unmistakably this hand. Judge the patterns as written — do not reward generically",
  "good prose that misses them, and do not punish prose that lands them somewhere you",
  "did not expect. For each dimension quote ONE short span from the sample as evidence:",
  "the span that most carried your read, or — when a dimension reads weak — the span",
  "where you most expected the pattern and did not find it.",
].join(" ");

/**
 * Build the checklist prompt — pure, exported for the prompt-spec pin, and
 * blind by construction: it can only render what VoicePatterns carries, and
 * VoicePatterns carries no dial. Dimensions with no named patterns are omitted
 * (there is nothing to check them against — the same graceful degradation the
 * axis scorer applies to an ungrounded axis), so the judge is never asked to
 * score an empty checklist.
 */
export function buildVoiceChecklistPrompt(patterns: VoicePatterns, sample: string): string {
  const blocks = measurableDimensions(patterns).map((dim) => {
    const lines = patterns[dim].map((p) => `  - ${p.replace(/\s+/g, " ").trim()}`).join("\n");
    return `${dim}:\n${lines}`;
  });
  return [
    "The author's fingerprint — the named patterns that make this hand recognizable:",
    "",
    blocks.join("\n\n"),
    "",
    "Prose sample (one continuous window, oldest scene first):",
    "---",
    sample,
    "---",
    "",
    `For each of the ${blocks.length} dimensions above, score 1–9 for how strongly this prose`,
    "exhibits that dimension's own named patterns, with one short evidence quote.",
  ].join("\n");
}

/**
 * Run the voice checklist through the traced trio (judgment tier). Returns one
 * read per REQUESTED dimension — unknown or duplicated names the model invents
 * are dropped, and a dimension it silently skips simply has no read this
 * sample (never evidence, exactly like a missing axis score).
 */
export async function judgeVoice(
  selection: TierSelection,
  opts: {
    patterns: VoicePatterns;
    /** The SAME stripped window the axis scorer read (§4.5 — one sample, two halves). */
    sample: string;
    campaignId?: string;
    turnNumber?: number;
  },
): Promise<VoiceDimensionRead[]> {
  const wanted = measurableDimensions(opts.patterns);
  if (wanted.length === 0) return [];

  const result = await callJudgment(selection, {
    name: "sakkan_voice",
    schema: VoiceChecklistSheet,
    system: VOICE_CHECKLIST_SYSTEM,
    prompt: buildVoiceChecklistPrompt(opts.patterns, opts.sample),
    effort: "low",
    maxTokens: STRUCTURED_SMALL,
    campaignId: opts.campaignId,
    turnNumber: opts.turnNumber,
  });

  const asked = new Set<string>(wanted);
  const seen = new Set<string>();
  const reads: VoiceDimensionRead[] = [];
  for (const r of result.dimensions) {
    if (!asked.has(r.name) || seen.has(r.name)) continue;
    seen.add(r.name);
    reads.push(r);
  }
  return reads;
}

/**
 * At or below this a dimension reads WEAK. Two consecutive weak samples on the
 * same dimension is the voice half's drift gate — the mirror of the axis band's
 * DRIFT_CONSECUTIVE: one weak read is a scene that happened to sit outside the
 * hand; two running is the hand going.
 */
export const VOICE_WEAK_SCORE = 4;

/** The author's own line, clipped to its first sentence — the anchor the pressure quotes. */
function firstSentence(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const sentence = (flat.match(/^.*?[.!?…。](?=\s|$)/)?.[0] ?? flat).trim();
  return sentence.length <= max ? sentence : `${sentence.slice(0, max).trimEnd()}…`;
}

/**
 * The pressure line (§4.5 M2R4): v1 corrects the voice through PRESSURE, never
 * a retake — the retake machinery is axis-shaped (it needs a numeric target to
 * expire against), and a fingerprint has no delta. One line, composed for the
 * Amendments: the weakest sustained dimension, ONE of its named patterns
 * quoted so the correction is concrete, and the author's own first sentence as
 * the anchor — the hand itself, not a description of it. Pure.
 */
export function composeVoicePressure(
  dimension: string,
  patterns: VoicePatterns,
  exampleVoice: string,
): string {
  const dim = (VOICE_DIMENSIONS as readonly string[]).includes(dimension)
    ? patterns[dimension as VoiceDimension]
    : [];
  const pattern = dim[0]?.replace(/\s+/g, " ").trim() ?? "";
  const hand = firstSentence(exampleVoice);
  const head = `Voice pressure (measured): "${dimension}" reads weak two samples running`;
  const wants = pattern ? ` — the register wants: "${pattern}".` : ".";
  const anchor = hand ? ` The author's hand: "${hand}"` : "";
  return `${head}${wants}${anchor}`;
}
