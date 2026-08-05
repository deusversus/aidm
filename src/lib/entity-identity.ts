/**
 * Deterministic entity-identity helpers shared by the two minting authorities
 * (SZ compiler catalog admission, §5.4 ingestion resolver). One character must
 * be one catalog row (§6.5); the live failure mode was the protagonist existing
 * as three npc rows by turn 3 — compiler near-dupes plus a resolver exact-name
 * miss. Semantic alias resolution (different names, same meaning) is M2; this
 * tier is equality-after-normalization only. Also home to the shared
 * voice-card compression (bottom) — entity identity and entity voice are the
 * two per-character truths more than one subsystem must agree on.
 */

import type { VoiceCard } from "@/lib/types/profile";

export function normalizeIdentity(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Identity key for map/dedup use (§6.5, M2 C1 empty-normalization guard):
 * null when normalization empties the name (all-punctuation "???" / "!!!"),
 * so two such names never collide on the "" key and merge into one row (the
 * M1-audit note). Keying call sites treat null as "no key" — keep the row
 * separate, never register the empty key.
 */
export function identityKey(name: string): string | null {
  const norm = normalizeIdentity(name);
  return norm.length > 0 ? norm : null;
}

/** Placeholder names the self-insert protagonist arrives under. Qualifiers like
 *  "(unnamed)" are stripped before this set is consulted. */
const PROTAGONIST_IDENTITIES = new Set([
  "protagonist",
  "the protagonist",
  "players protagonist",
  "player protagonist",
  "player character",
  "the player character",
  "self insert",
  "the self insert",
]);

/** Self-insert markers strong enough to bind text to the protagonist even when
 *  its NAME is real (the description gives it away). Deliberately narrow:
 *  "the protagonist's rival" must NOT trip this. */
const SELF_INSERT_MARKERS = [
  "player's protagonist",
  "players protagonist",
  "player character",
  "player-character",
  "self-insert",
  "self insert",
];

export function isProtagonistName(name: string): boolean {
  const core = normalizeIdentity(name)
    .replace(/\b(unnamed|tbd|unknown|nameless)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return PROTAGONIST_IDENTITIES.has(core);
}

export function marksSelfInsert(text: string): boolean {
  const t = text.toLowerCase();
  return SELF_INSERT_MARKERS.some((m) => t.includes(m));
}

/**
 * True when an entity's structured `state` carries the SZ compiler's durable
 * self-insert marker (§6.5, M2 C4). A REAL-named PC row ("Kaelen") fails
 * `isProtagonistName`, so after C4 the resolver's sentinel aliasing keys off
 * this marker: without it, a named PC row would lose the protagonist alias and
 * "the protagonist" assertions would exact-miss it, re-opening the turn-3 dupe
 * hole. The compiler stamps `state.is_player_protagonist = true` at admission.
 */
export function marksPlayerProtagonistState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { is_player_protagonist?: unknown }).is_player_protagonist === true
  );
}

/** The ~200-char ceiling both voice-card readers share — one clip, one truth. */
export const VOICE_CARD_FINGERPRINT_CHARS = 200;

/**
 * §4.7/§6.5 (M2 C8): compress a research voice card into the fingerprint the
 * KA reads on speaking-cast turns — how the character sounds, not their
 * biography. TWO call sites, ONE implementation on purpose: the ingest-time
 * stamp (`state.voice_card` on canon link) and the read-time contract
 * fallback for present-cast cards (§4.1) both surface through renderEntityCard's
 * `voice:` line, so divergent copies would hand the pen two versions of the
 * same character's sound. (Hoisted 2026-08-05 — the copies existed only
 * because M3R2 C5 was fenced out of ingest.ts by a concurrent owner.)
 */
export function voiceCardLine(card: VoiceCard): string {
  const phrase = card.signature_phrases.find((p) => p.trim().length > 0);
  const text = [
    card.speech_patterns,
    card.dialogue_rhythm,
    card.emotional_expression.toLowerCase(),
    phrase ? `e.g. "${phrase}"` : "",
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("; ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > VOICE_CARD_FINGERPRINT_CHARS
    ? `${text.slice(0, VOICE_CARD_FINGERPRINT_CHARS).trimEnd()}…`
    : text;
}
