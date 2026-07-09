import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { episodicRecords } from "@/lib/db/schema";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import { and, desc, eq } from "drizzle-orm";
import { STYLE_DRIFT_POOL, type StyleDrift } from "./diversity";

/**
 * Anti-repetition suite (blueprint §5.3) — the *measured* half of the
 * diversity machinery. Where `diversity.ts` carries v3's shuffle-bag and
 * construction-regex craft material, this module is the detector: it reads
 * the last three narrated scenes and injects a directive ONLY when it can
 * measure a specific repetition. Doctrine (§5.3, axiom 5): "corrective
 * pressure is injected only when measurement says so" — never as standing
 * pressure. All computation here is code; the sole model traffic is the
 * metered Voyage embedding call (judgment-in-LLM, computation-in-code).
 *
 * Two independent readings, either of which may fire:
 *   1. Opening-type repetition — classify the opening of each of the last 3
 *      scenes; if ≥2 share a type, emit a style-drift directive drawn from a
 *      pattern-specific bag (§5.3 "opening-type classification … ≥2 of a
 *      kind"). The bag reuses `diversity.ts`'s STYLE_DRIFT_POOL as the craft
 *      vocabulary, filtered to the moves that BREAK the repeated pattern.
 *   2. Vocabulary clustering — embedding-similarity over the same 3 scenes
 *      (§5.3 "embedding-similarity clustering … rather than regex") plus a
 *      code-level repeated-n-gram check that names the offending phrase.
 */

// ── Tunable constants ───────────────────────────────────────────────────────

/** Scenes considered for both readings (§5.3 "the last 3 scenes"). */
const RECENT_SCENES = 3;
/** Below this, both readings are undefined and no Voyage call is made. */
const MIN_NARRATIONS = 3;
/** First ~200 chars is "the opening" for classification (task spec). */
const OPENING_WINDOW_CHARS = 200;
/** Scenery lexicon must land in the opening words, not a trailing mention. */
const SCENERY_LOOKAHEAD_WORDS = 6;
/** Per-scene text embedded for the texture-convergence check (token guard). */
const EMBED_SEGMENT_CHARS = 2_000;
/** All three pairwise cosines above this ⇒ scenes converging in texture. */
export const VOCAB_CLUSTER_THRESHOLD = 0.82;
/** n for the repeated-phrase check (§5.3 code-level, "4+-gram"). */
const REPEATED_NGRAM_N = 4;
/** Cap on named phrases in the advisory (prescription budget, axiom 4). */
const MAX_NAMED_PHRASES = 3;

// ── Public contract ─────────────────────────────────────────────────────────

export interface RepetitionReadings {
  /** Set when opening-type repetition is measured over the last 3 scenes. */
  styleDriftDirective?: string;
  /** Set when vocabulary clustering / phrase repetition is measured. */
  vocabFreshnessAdvisory?: string;
}

// ── 1. Opening-type classification ───────────────────────────────────────────

export type OpeningType = "dialogue" | "action" | "scenery" | "interiority";

/**
 * Thought/feeling verbs marking an interiority open. Kept to clearly-interior
 * cognition/emotion verbs so an action open ("Spike wanted the door open")
 * doesn't get miscounted — false negatives here are cheap, false positives
 * dilute the measured signal.
 */
const INTERIORITY_RE =
  /\b(?:felt|feel|feels|feeling|thought|think|thinks|thinking|knew|know|knows|knowing|wondered|wonder|wonders|remembered|remember|remembers|realized|realize|realizes|hoped|hopes|feared|fears|sensed|senses|believed|believes|understood|understands|imagined|imagines|dreaded|regretted|doubted|ached|yearned|longed)\b/i;

/**
 * Weather / light / time-of-day lexicon. Deliberately excludes generic place
 * nouns ("room", "alley") — those appear in action openings too often and
 * would swamp the signal; a spatial-adverbial lead (below) covers genuine
 * establishing opens that name a place.
 */
const SCENERY_WORD_RE =
  /\b(?:rain|rains|raining|rained|wind|winds|windy|snow|snows|snowing|storm|storms|stormy|fog|foggy|mist|misty|cloud|clouds|cloudy|sun|sunlight|sunshine|sunset|sunrise|sky|skies|thunder|lightning|drizzle|sleet|hail|frost|breeze|gale|heat|chill|light|darkness|shadow|shadows|glow|gleam|gloom|dusk|dawn|daybreak|twilight|moonlight|starlight|lamplight|neon|haze|morning|noon|midday|afternoon|evening|night|nightfall|midnight)\b/i;

/** Spatial adverbial lead — an establishing sweep that opens on place. */
const SPATIAL_LEAD_RE =
  /^\s*(?:outside|inside|above|below|beyond|across|beneath|overhead|around|somewhere|everywhere|far off|in the distance)\b/i;

/** Opening punctuation that marks a scene led by a spoken line. */
const DIALOGUE_LEAD_RE = /^["“”‘'«—–]/;

/**
 * Classify how a scene opens. Coarse by design — enough to catch "three
 * dialogue opens in a row" without beat-for-beat cleverness. Priority order
 * (documented): dialogue → interiority → scenery → action.
 *   - dialogue: the opening's first non-space char is a quote or em-dash.
 *   - interiority: a cognition/emotion verb in the first sentence (a marked
 *     psychological signal takes precedence over ambient scenery).
 *   - scenery: weather/light/time vocabulary in the first few words, or a
 *     spatial-adverbial lead ("Outside, …") — an establishing open.
 *   - action: the residual — a character (name/pronoun) simply doing
 *     something, which is what remains once the marked opens are removed.
 */
export function classifyOpening(text: string): OpeningType {
  const opening = text.trim().slice(0, OPENING_WINDOW_CHARS);
  if (DIALOGUE_LEAD_RE.test(opening)) return "dialogue";

  const firstSentence = opening.split(/(?<=[.!?])\s+/)[0] ?? opening;
  if (INTERIORITY_RE.test(firstSentence)) return "interiority";

  const firstWords = firstSentence.trim().split(/\s+/).slice(0, SCENERY_LOOKAHEAD_WORDS).join(" ");
  if (SPATIAL_LEAD_RE.test(opening) || SCENERY_WORD_RE.test(firstWords)) return "scenery";

  return "action";
}

/** The opening type shared by ≥2 of the classified scenes, or null. */
export function modalOpeningType(types: OpeningType[]): OpeningType | null {
  const counts = new Map<OpeningType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [type, count] of counts) {
    if (count >= 2) return type;
  }
  return null;
}

// ── Style-drift shuffle bag (pattern-specific, reusing STYLE_DRIFT_POOL) ─────

/**
 * Moves from the pool that would REINFORCE each opening type — excluded from
 * that type's break-bag so the directive always pushes AWAY from the measured
 * pattern. Action has no pure reinforcer in the pool, so its bag is the whole
 * pool.
 */
const REINFORCING: Record<OpeningType, readonly StyleDrift[]> = {
  dialogue: ["open with dialogue"],
  action: [],
  scenery: ["try environmental POV", "lead with sensory detail"],
  interiority: ["open with interiority"],
};

/** Pattern-specific lead — names the repetition and the element to withhold. */
const PATTERN_LEAD: Record<OpeningType, string> = {
  dialogue: "The last few scenes have all opened on a spoken line. Hold dialogue back a beat and",
  action:
    "The last few scenes have all opened on a character already in motion. Change the entry —",
  scenery:
    "The last few scenes have all opened by establishing weather or setting. Skip the establishing sweep and",
  interiority:
    "The last few scenes have all opened inside a character's head. Start outside them —",
};

function breakBag(type: OpeningType): StyleDrift[] {
  const disallow = new Set(REINFORCING[type]);
  return STYLE_DRIFT_POOL.filter((m) => !disallow.has(m));
}

/** Stable non-negative hash so different campaigns rotate on different phases. */
function hashString(s: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/**
 * Pick a pattern-breaking directive. Deterministic in (type, campaignId,
 * counter); rotating `counter` by 1 advances the bag index by 1, so
 * consecutive turns never draw the same directive twice running (§5.3). The
 * counter is the latest scene's turn number — monotonic across turns.
 */
export function pickBreakDirective(type: OpeningType, campaignId: string, counter: number): string {
  const bag = breakBag(type);
  const idx = (hashString(campaignId) + counter) % bag.length;
  const move = bag[idx] ?? bag[0] ?? "vary the opening";
  return `${PATTERN_LEAD[type]} ${move} this time (unless the scene actively resists it — then write what the scene wants).`;
}

// ── 2. Vocabulary freshness ──────────────────────────────────────────────────

/** Every pairwise cosine above the threshold ⇒ the cluster is too tight. */
export function allPairsSimilar(embeddings: number[][], threshold: number): boolean {
  if (embeddings.length < 2) return false;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const a = embeddings[i];
      const b = embeddings[j];
      if (!a || !b) return false;
      if (cosineSimilarity(a, b) <= threshold) return false;
    }
  }
  return true;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/**
 * Proper nouns = words capitalized mid-sentence (sentence-initial words are
 * skipped — their capital is just orthography). Repeated phrases anchored on
 * a character/place name aren't prose ossification, so they're excluded.
 */
function collectProperNouns(narrations: string[]): Set<string> {
  const proper = new Set<string>();
  for (const text of narrations) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const words = sentence.trim().split(/\s+/);
      for (let i = 1; i < words.length; i++) {
        const clean = (words[i] ?? "").replace(/[^A-Za-z']/g, "");
        if (/^[A-Z][a-z]+$/.test(clean)) proper.add(clean.toLowerCase());
      }
    }
  }
  return proper;
}

function ngramSet(text: string, n: number): Set<string> {
  const toks = tokenize(text);
  const set = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) {
    set.add(toks.slice(i, i + n).join(" "));
  }
  return set;
}

/**
 * n-grams appearing in ≥2 of the narrations, excluding any gram that touches
 * an IP-jargon term (power-system / stat names, from the caller) or a proper
 * noun. The whitelist is what keeps "cursed energy flared again" from being
 * flagged as a tic in a Jujutsu campaign.
 */
export function findRepeatedNgrams(
  narrations: string[],
  opts: { jargonWhitelist: string[]; n?: number; max?: number },
): string[] {
  const n = opts.n ?? REPEATED_NGRAM_N;
  const max = opts.max ?? MAX_NAMED_PHRASES;
  const jargon = new Set(opts.jargonWhitelist.map((w) => w.toLowerCase()));
  const proper = collectProperNouns(narrations);

  const docCount = new Map<string, number>();
  for (const text of narrations) {
    for (const gram of ngramSet(text, n)) {
      docCount.set(gram, (docCount.get(gram) ?? 0) + 1);
    }
  }

  const repeated: string[] = [];
  for (const [gram, count] of docCount) {
    if (count < 2) continue;
    const tokens = gram.split(" ");
    if (tokens.some((t) => jargon.has(t) || proper.has(t))) continue;
    repeated.push(gram);
  }
  return repeated.slice(0, max);
}

/** Assemble the advisory prose from whichever vocabulary signals fired. */
export function composeVocabAdvisory(tight: boolean, phrases: string[]): string | undefined {
  const parts: string[] = [];
  if (tight) {
    parts.push(
      "recent scenes are converging in texture — vary sentence rhythm and sensory register",
    );
  }
  if (phrases.length > 0) {
    const named = phrases.map((p) => `"${p}"`).join(", ");
    parts.push(
      `these exact phrasings recur across recent scenes — retire them this beat: ${named}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// ── The measured entry point ─────────────────────────────────────────────────

/**
 * Measure repetition over the last 3 episodic narrations and return only the
 * directives that fire. Fewer than 3 scenes ⇒ both undefined and NO embedding
 * call (most campaigns are young — the guard is load-bearing for cost).
 */
export async function measureRepetition(
  db: Db,
  campaignId: string,
  opts: { jargonWhitelist: string[] },
): Promise<RepetitionReadings> {
  const rows = await db
    .select({ narration: episodicRecords.narration, turnNumber: episodicRecords.turnNumber })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(RECENT_SCENES);
  if (rows.length < MIN_NARRATIONS) return {};

  const narrations = rows.map((r) => r.narration);
  const counter = rows[0]?.turnNumber ?? 0;
  const readings: RepetitionReadings = {};

  // (1) Opening-type repetition — pure code, no model call.
  const modal = modalOpeningType(narrations.map(classifyOpening));
  if (modal) readings.styleDriftDirective = pickBreakDirective(modal, campaignId, counter);

  // (2) Vocabulary freshness — embedding clustering + repeated-phrase naming.
  const segments = narrations.map((n) => n.slice(0, EMBED_SEGMENT_CHARS));
  const embeddings = await embedTexts(segments, {
    patience: "interactive",
    inputType: "document",
    campaignId,
    turnNumber: counter,
  });
  const tight = allPairsSimilar(embeddings, VOCAB_CLUSTER_THRESHOLD);
  const phrases = findRepeatedNgrams(narrations, { jargonWhitelist: opts.jargonWhitelist });
  const advisory = composeVocabAdvisory(tight, phrases);
  if (advisory) readings.vocabFreshnessAdvisory = advisory;

  return readings;
}
