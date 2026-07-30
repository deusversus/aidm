/**
 * The retake (§6.7, M2R7): the transcript IS the picker. These are the pure
 * rules behind the mode — which replies can be returned to, how much un-happens,
 * the draft the composer inherits, and the two session keys that carry a retake
 * across the post-confirm reload. Kept out of the client component so they
 * unit-test without a DOM harness.
 *
 * The wire semantics never changed, only the labels: the route takes `toTurn: N`
 * meaning "N is the last turn that KEEPS happening". The old UI named the turn
 * being destroyed; this names the place being returned to.
 */

/** The play view's retake depth. Mirrors MAX_PLAY_VIEW_REWIND (`src/lib/turn/
 *  rewind.ts`) — that module drags the db/schema graph, which must never enter
 *  the client bundle, so the constant is restated here and pinned by test. */
export const RETAKE_HORIZON = 10;

/** The minimum the retake rules need from a transcript item. */
export interface RetakeItem {
  kind?: "story" | "channel";
  turnNumber: number;
  playerInput: string;
}

/** Booth/override lines are out of fiction (§5.4) — not places in the story (C9). */
function isStory(item: RetakeItem): boolean {
  return item.kind !== "channel";
}

/** The campaign's latest turn number as the transcript knows it (story AND
 *  channel — the route's horizon counts turn numbers, not story beats). */
export function latestTurnNumber(items: readonly RetakeItem[]): number {
  return items.reduce((max, i) => (i.turnNumber > max ? i.turnNumber : max), 0);
}

/** Beyond the retake horizon — dimmed, tooltipped, never selectable. */
export function beyondRetakeHorizon(items: readonly RetakeItem[], turnNumber: number): boolean {
  return latestTurnNumber(items) - turnNumber > RETAKE_HORIZON;
}

/** Story turns that un-happen if the player returns to `toTurn`. */
export function unwoundCount(items: readonly RetakeItem[], toTurn: number): number {
  return items.filter((i) => isStory(i) && i.turnNumber > toTurn).length;
}

/**
 * Booth/channel exchanges that un-happen too. They are not story moments, but
 * the rewind deletes their rows and tombstones any standing rule minted in
 * them — the slate says so instead of counting only the story (M2R7 audit:
 * the count and the dim must agree about what disappears).
 */
export function unwoundBoothCount(items: readonly RetakeItem[], toTurn: number): number {
  return items.filter((i) => !isStory(i) && i.turnNumber > toTurn).length;
}

/**
 * The player's FIRST unwound input — the draft the composer inherits after the
 * retake, because the dominant reason to retake is "let me say that
 * differently" (M2R7 §4).
 */
export function firstUnwoundInput(items: readonly RetakeItem[], toTurn: number): string | null {
  const after = items
    .filter((i) => isStory(i) && i.turnNumber > toTurn)
    .sort((a, b) => a.turnNumber - b.turnNumber);
  const text = after[0]?.playerInput?.trim();
  return text ? text : null;
}

/**
 * The story replies that can be returned to: inside the horizon, with at least
 * one story turn after them (returning to the newest reply un-happens nothing).
 */
export function retakeTargets(items: readonly RetakeItem[]): ReadonlySet<number> {
  const targets = new Set<number>();
  for (const item of items) {
    if (!isStory(item)) continue;
    // turn 0 is the opening anchor's territory, never a reply's: a payload
    // that ever defaulted a missing turnNumber to 0 must not render a
    // "Return here" that quietly restarts the campaign (M2R7 audit).
    if (item.turnNumber < 1) continue;
    if (beyondRetakeHorizon(items, item.turnNumber)) continue;
    if (unwoundCount(items, item.turnNumber) < 1) continue;
    targets.add(item.turnNumber);
  }
  return targets;
}

/**
 * The opening anchor (`toTurn: 0` — replay from the first scene). Offered only
 * while the whole story is still inside the horizon; the route rejects a deeper
 * reach, and an affordance that 400s is a lie.
 */
export function openingRetakeAvailable(items: readonly RetakeItem[]): boolean {
  const latest = latestTurnNumber(items);
  return latest > 0 && latest <= RETAKE_HORIZON && unwoundCount(items, 0) >= 1;
}

/** The composer's inherited draft, read once after the post-retake reload. */
export function retakeDraftKey(campaignId: string): string {
  return `aidm:play:retake-draft:${campaignId}`;
}

/** The seam's turn number — a marker for this sitting only, read once. */
export function retakeSeamKey(campaignId: string): string {
  return `aidm:play:retake-seam:${campaignId}`;
}
