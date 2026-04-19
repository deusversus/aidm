/**
 * Post-hoc portrait map extraction.
 *
 * KA's Block 1 instructs it to bold names with `**Name**` on first
 * mention per scene. This function scans the streamed narrative text
 * after KA finishes and produces a map of npc_name → portrait_url.
 *
 * KA doesn't know portraits exist — the scan runs independently so a
 * portrait retrieval failure never blocks or alters narration. Per
 * v3's pattern (`resolve_portraits()` in `key_animator.py`).
 *
 * At M1 the URL lookup is a stub — no NPC portraits are generated yet
 * (ProductionAgent media wiring lands at M4+). We return the name
 * set so persistence records WHO appeared, which enables later
 * production runs to fill URLs retroactively.
 */

const BOLD_NAME_RE = /\*\*([A-Z][A-Za-z'\-]*(?:\s+[A-Z][A-Za-z'\-]*)*)\*\*/g;

/**
 * Extract every `**Name**` bolded in the narrative. Returns the set of
 * distinct names in first-mention order (Map preserves insertion).
 * Names are returned as they appear, case-sensitive.
 *
 * Excludes single-letter matches and ALL-CAPS tokens (those usually
 * indicate scene labels or DM-annotations like `**BANG**`, not
 * proper-name mentions).
 */
export function extractNames(narrative: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  // Use matchAll to avoid assign-in-condition lint.
  BOLD_NAME_RE.lastIndex = 0;
  for (const match of narrative.matchAll(BOLD_NAME_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    if (name.length < 2) continue;
    // Skip ALL-CAPS single tokens (likely onomatopoeia / scene labels)
    if (/^[A-Z]+$/.test(name)) continue;
    if (!seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

/** Resolve a name to its portrait URL. Returns null if not catalogued. */
export type PortraitResolver = (name: string) => Promise<string | null>;

/**
 * Build a portrait map from extracted names. Unresolved names are
 * present in the map with null URL so downstream consumers can tell
 * "we know this person appeared, no portrait yet" from "we never
 * caught the mention."
 */
export async function buildPortraitMap(
  narrative: string,
  resolver: PortraitResolver,
): Promise<Record<string, string | null>> {
  const names = extractNames(narrative);
  const map: Record<string, string | null> = {};
  for (const name of names) {
    map[name] = await resolver(name);
  }
  return map;
}

/** Default resolver stub. Returns null for every name. */
export const stubPortraitResolver: PortraitResolver = async () => null;
