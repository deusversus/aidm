/**
 * Deterministic entity-identity helpers shared by the two minting authorities
 * (SZ compiler catalog admission, §5.4 ingestion resolver). One character must
 * be one catalog row (§6.5); the live failure mode was the protagonist existing
 * as three npc rows by turn 3 — compiler near-dupes plus a resolver exact-name
 * miss. Semantic alias resolution (different names, same meaning) is M2; this
 * tier is equality-after-normalization only.
 */

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
