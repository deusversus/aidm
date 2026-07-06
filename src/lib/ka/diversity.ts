/**
 * Narrative diversity machinery (§7.4).
 *
 * Long-horizon prose ossifies into a few signature moves if you don't
 * push against it. v3 watched this happen over 100+ turn runs and
 * derived two mitigations; v4 inherits both verbatim.
 *
 * Both outputs go into Block 4 as soft advisories — they don't override
 * Profile DNA voice; they shape structural diversity within it.
 *
 * 1. Style-drift shuffle-bag — pool of 8 structural nudges. Fires only
 *    when recent narration is converging. Filtered by intent and
 *    narrative weight (no "open with dialogue" during COMBAT;
 *    no "environmental POV" during CLIMACTIC).
 * 2. Vocabulary-freshness regex — scans recent DM prose for
 *    construction-level repetition (similes, personification,
 *    negation triples). Flags the top N repeat constructions for KA
 *    to avoid this turn.
 */

import type { IntentOutput, NarrativeWeight } from "@/lib/types/turn";

// ============================================================================
// Style drift shuffle-bag (§7.4)
// ============================================================================

export const STYLE_DRIFT_POOL = [
  "open with dialogue",
  "try environmental POV",
  "include one 40+ word flowing sentence",
  "cold open",
  "lead with sensory detail",
  "open with interiority",
  "fragment the beat into short cuts",
  "shift to second-person moment",
] as const;

export type StyleDrift = (typeof STYLE_DRIFT_POOL)[number];

const CLIMACTIC_DISALLOW: readonly StyleDrift[] = ["try environmental POV"];
const INTENT_DISALLOW: Record<string, readonly StyleDrift[]> = {
  COMBAT: ["open with dialogue"],
  META_FEEDBACK: ["try environmental POV", "cold open", "shift to second-person moment"],
};

/**
 * Classify how a DM message opens, for the convergence check. Coarse —
 * enough to detect "three dialogue openings in a row" without trying
 * to be clever beat-for-beat.
 *
 * Non-pronoun/non-article openings bundle under the exact first word so
 * same-subject openings cluster ("Spike walked…", "Spike lit…" converge
 * to `named:spike`). This is what catches prose-ossification that
 * length-based heuristics miss.
 */
function classifyOpening(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith('"') || firstLine.startsWith("“") || firstLine.startsWith("—")) {
    return "dialogue";
  }
  const firstWordMatch = firstLine.match(/^(\S+)/);
  const firstWord = firstWordMatch?.[1]?.replace(/[.,;:!?]$/, "").toLowerCase() ?? "";
  if (["you", "he", "she", "they", "i"].includes(firstWord)) return "pronoun_action";
  if (["the", "a", "an"].includes(firstWord)) return "descriptor";
  if (firstWord.length > 1) return `named:${firstWord}`;
  return "prose";
}

export interface StyleDriftInput {
  /** Last 6 narration texts in order (oldest → newest). */
  recentNarrations: string[];
  intent: IntentOutput;
  narrativeWeight: NarrativeWeight | undefined;
  /** Style directives injected in the last 3 turns; avoid repeating. */
  recentlyUsed: StyleDrift[];
  /** Deterministic random source for tests. Defaults to Math.random. */
  random?: () => number;
}

/**
 * Pick a style-drift directive, or null if the recent opens are already
 * diverse enough to skip the advisory.
 */
export function pickStyleDrift(input: StyleDriftInput): StyleDrift | null {
  const random = input.random ?? Math.random;

  // Convergence check — if the last 3 narrations already show variety
  // in opening classification, skip.
  const last3 = input.recentNarrations.slice(-3);
  if (last3.length >= 3) {
    const classes = new Set(last3.map(classifyOpening));
    if (classes.size >= 2) return null;
  }

  // Build candidate pool. Filter out:
  //   - disallowed for current intent
  //   - disallowed for CLIMACTIC beats
  //   - recently-used (no repeat in the last 3 turns)
  const disallowed = new Set<StyleDrift>([
    ...(INTENT_DISALLOW[input.intent.intent] ?? []),
    ...(input.narrativeWeight === "CLIMACTIC" ? CLIMACTIC_DISALLOW : []),
    ...input.recentlyUsed,
  ]);
  const candidates = STYLE_DRIFT_POOL.filter((d) => !disallowed.has(d));
  if (candidates.length === 0) return null;

  const idx = Math.floor(random() * candidates.length);
  return candidates[idx] ?? null;
}

// ============================================================================
// Vocabulary freshness regex (§7.4)
// ============================================================================

/**
 * Regex patterns for construction-level repetition detection. If the
 * same CONSTRUCTION (not the same words — the same shape) appears ≥ 3
 * times across the recent DM narrations, flag it as ossifying.
 *
 * Patterns are intentionally loose — false positives are cheap
 * (KA gets one more advisory to ignore); false negatives are expensive
 * (prose ossifies unnoticed).
 */
const CONSTRUCTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Simile: "like/as a/an NOUN" — minimal match so "like a cat" hits.
  { name: "simile_like_a", re: /\b(?:like|as)\s+(?:a|an)\s+\w+/gi },
  { name: "simile_like_if", re: /\blike\s+if\s+\w+/gi },
  { name: "simile_as_X_as_Y", re: /\bas\s+\w+\s+as\s+\w+/gi },
  { name: "simile_comma_like", re: /,\s*like\s+\w+/gi },
  // Personification: "adjective adverb" pairs / "with the X of Y" metaphor
  { name: "adj_adverb", re: /\b\w+ly\s+\w+s\b/g },
  { name: "with_the_X_of", re: /\bwith\s+the\s+\w+\s+of\s+a\s+\w+/gi },
  // Negation triples
  { name: "not_X_not_Y", re: /\bNot\s+\w[\w\s]{0,20}\.\s+Not\s+\w/g },
];

export interface VocabFreshnessInput {
  /** Recent DM narration texts to scan. Typical: last 3 turns. */
  recentNarrations: string[];
  /** Proper-noun whitelist from profile (voice cards, power system). */
  properNouns?: Set<string>;
  /** Jargon whitelist (combat system, tropes, power tiers). */
  jargonAllowlist?: Set<string>;
  /** Threshold for flagging. Default 3 (v3 value). */
  repeatThreshold?: number;
  /** Max number of constructions to surface. Default 5 (v3 value). */
  topN?: number;
}

export interface FlaggedConstruction {
  pattern: string;
  examples: string[];
  count: number;
}

export function detectStaleConstructions(input: VocabFreshnessInput): FlaggedConstruction[] {
  const threshold = input.repeatThreshold ?? 3;
  const topN = input.topN ?? 5;
  const properNouns = input.properNouns ?? new Set<string>();
  const jargon = input.jargonAllowlist ?? new Set<string>();

  const allText = input.recentNarrations.join("\n");
  const flagged: FlaggedConstruction[] = [];

  for (const { name, re } of CONSTRUCTION_PATTERNS) {
    const matches: string[] = [];
    re.lastIndex = 0;
    for (const m of allText.matchAll(re)) {
      const match = m[0];
      // Skip if match is mostly a proper noun (name-adjacent patterns
      // always trip "like" constructions; don't flag them).
      const words = match.split(/\s+/);
      const proper = words.filter((w) => properNouns.has(w.replace(/[.,]$/, "")));
      if (proper.length > words.length / 2) continue;
      const inJargon = words.some((w) => jargon.has(w.toLowerCase().replace(/[.,]$/, "")));
      if (inJargon) continue;
      matches.push(match);
    }
    if (matches.length >= threshold) {
      flagged.push({
        pattern: name,
        examples: matches.slice(0, 3),
        count: matches.length,
      });
    }
  }

  return flagged.sort((a, b) => b.count - a.count).slice(0, topN);
}

// ============================================================================
// Block 4 rendering helpers
// ============================================================================

/** Render a style-drift directive for Block 4 injection. */
export function renderStyleDriftDirective(drift: StyleDrift | null): string {
  if (!drift) return "";
  return `## Style drift this turn\n\nOpening or structural nudge for this beat: ${drift}. Use it unless the scene actively resists it; if it resists, ignore and write what the scene wants.`;
}

/** Render a vocabulary freshness advisory for Block 4 injection. */
export function renderVocabFreshnessAdvisory(flagged: FlaggedConstruction[]): string {
  if (flagged.length === 0) return "";
  const lines = flagged.map(
    (f) => `  - ${f.pattern} (${f.count}×) — e.g. ${f.examples.map((e) => `"${e}"`).join(", ")}`,
  );
  return [
    "## Vocabulary freshness",
    "",
    "Recent DM prose is repeating these constructions. Reach for a different shape this turn:",
    "",
    lines.join("\n"),
  ].join("\n");
}
