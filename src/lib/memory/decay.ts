import type { Db } from "@/lib/db";
import { semanticMemories } from "@/lib/state/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * Semantic-memory heat physics (§9.1 decay curves — v3-parity Phase 4).
 *
 * Heat is on [0, 100]. At insert it's 100 by default ("start hot, let
 * decay do the work"). Each turn-distance applies the category's decay
 * multiplier (compounding); floors respect `plot_critical` +
 * `milestone_relationship` flags. Without decay, every memory sits at
 * insert-time heat forever — retrieval ranking reduces to recency +
 * hand-waved baseline, and the long tail clogs candidate pools.
 *
 * v3 ran decay at read time (compute heat on-query). v4 runs it at
 * turn-close (Chronicler end-of-pass) so every read is cheap and no
 * query needs to reimplement the formula. The tradeoff: a memory
 * queried between decay runs sees yesterday's value — acceptable at
 * turn granularity.
 *
 * Boost-on-access: every candidate returned by `search_memory` gets a
 * heat bump — relationships +30, others +20 — clamped at 100. Keeps
 * frequently-relevant memories hot even as background decay chips away.
 *
 * Static boost (M4 retrieval runtime): session_zero / plot_critical get
 * +0.3 relevance bump, `episode` gets +0.15, applied after cosine + before
 * MemoryRanker rerank. Scaffolded here via `STATIC_BOOST`; wired in M4.
 */

export type DecayCurve = "none" | "very_slow" | "slow" | "normal" | "fast" | "very_fast";

/**
 * Per-curve multipliers applied per turn of distance from a memory's
 * turn_number. heat_new = heat_old * multiplier^(delta_turns). v3 values
 * verbatim.
 */
export const DECAY_CURVES: Record<DecayCurve, number> = {
  none: 1.0,
  very_slow: 0.97,
  slow: 0.95,
  normal: 0.9,
  fast: 0.8,
  very_fast: 0.7,
};

/**
 * Category → decay curve mapping. Chronicler-authored categories should
 * always map to one of these; unknown falls back to "normal". The table
 * is the policy knob — edits here reshape the long tail of memory.
 */
export const CATEGORY_DECAY: Record<string, DecayCurve> = {
  // Sacred — never decay
  core: "none",
  session_zero: "none",
  session_zero_voice: "none",
  // Very slow — relational bonds accumulate slowly
  relationship: "very_slow",
  // Slow — events, facts, location details matter for dozens of turns
  consequence: "slow",
  fact: "slow",
  npc_interaction: "slow",
  location: "slow",
  location_fact: "slow",
  narrative_beat: "slow",
  backstory: "slow",
  lore: "slow",
  faction_fact: "slow",
  // Normal — quest + world_state + events decay at baseline
  quest: "normal",
  world_state: "normal",
  event: "normal",
  npc_state: "normal",
  ability_fact: "normal",
  // Fast — character_state (hunger, fatigue, current location) expires quickly
  character_state: "fast",
  // Very fast — one-episode summaries decay quickly so they don't dominate
  // recall once the episode is out of working memory
  episode: "very_fast",
};

/**
 * Resolve the decay curve for a category, defaulting to "normal" when
 * Chronicler invents a new category we haven't mapped yet.
 */
export function curveFor(category: string): DecayCurve {
  return CATEGORY_DECAY[category] ?? "normal";
}

/**
 * Boost-on-access deltas per category. Applied when `search_memory`
 * surfaces a candidate — keeps frequently-relevant memories hot.
 */
export const BOOST_ON_ACCESS: { relationship: number; default: number } = {
  relationship: 30,
  default: 20,
};

/**
 * Static boost applied during retrieval ranking (M4-gated — wired in the
 * semantic retrieval runtime once the embedder decision lands). Scaffolded
 * here so callers can reference the same constants now.
 */
export const STATIC_BOOST: {
  session_zero: number;
  plot_critical: number;
  episode: number;
} = {
  session_zero: 0.3,
  plot_critical: 0.3,
  episode: 0.15,
};

export interface MemoryFlags {
  plot_critical?: boolean;
  milestone_relationship?: boolean;
  boost_priority?: number;
}

/**
 * Compute the heat floor for a memory given its flags. Plot-critical
 * items can't decay below their current value (stored heat); relationship
 * milestones floor at 40. Default floor is 1 (heat can't reach 0 — retains
 * a trace so the memory never becomes invisible to retrieval).
 */
export function heatFloor(flags: MemoryFlags | null | undefined, currentHeat: number): number {
  if (flags?.plot_critical) return currentHeat;
  if (flags?.milestone_relationship) return 40;
  return 1;
}

/**
 * Run decay on every memory in a campaign, advancing their heat to
 * reflect turn distance from `currentTurn`. Called from Chronicler's
 * end-of-pass (or manually via maintenance script).
 *
 * SQL does the math inline with a CASE expression so it's one round-trip
 * and the DB clamps at the floor. Performance: O(rows); adds O(n ms) to
 * the turn's post-response latency. For N > 10k semantic memories the
 * per-campaign wrapper should move to a background job (trivial later).
 */
export async function decayHeat(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<{ rowsAffected: number }> {
  // Build a CASE expression that maps each known category to its
  // multiplier. Unknown categories default to `normal` (0.90). Category
  // keys are our own enum (no user input); safe to interpolate but we
  // single-quote-escape defensively anyway.
  const whenClauses = Object.entries(CATEGORY_DECAY)
    .map(([cat, curve]) => {
      const escaped = cat.replace(/'/g, "''");
      return `WHEN '${escaped}' THEN ${DECAY_CURVES[curve]}`;
    })
    .join(" ");
  const multiplierExpr = sql.raw(`CASE category ${whenClauses} ELSE ${DECAY_CURVES.normal} END`);
  // delta_turns = max(0, currentTurn - turn_number). New memories (same
  // turn) don't decay on their insert-turn.
  const deltaExpr = sql`GREATEST(0, ${currentTurn}::int - "turn_number")`;
  // floor = plot_critical(heat) -> current heat, milestone_relationship -> 40, else -> 1
  const floorExpr = sql`
    CASE
      WHEN flags ->> 'plot_critical' = 'true' THEN heat
      WHEN flags ->> 'milestone_relationship' = 'true' THEN 40
      ELSE 1
    END
  `;
  const decayedExpr = sql`GREATEST(${floorExpr}, FLOOR(heat * POWER(${multiplierExpr}, ${deltaExpr}))::int)`;

  const result = await db
    .update(semanticMemories)
    .set({ heat: decayedExpr as unknown as number })
    .where(eq(semanticMemories.campaignId, campaignId));
  // Drizzle returns different shapes by driver; best-effort row count.
  const rowsAffected =
    (result as unknown as { rowCount?: number; count?: number }).rowCount ??
    (result as unknown as { count?: number }).count ??
    0;
  return { rowsAffected };
}

/**
 * Boost heat on a specific memory that was just accessed via retrieval.
 * Called from `search_memory` after returning the top-k so the rows
 * that proved relevant stay hot. Clamps at 100.
 */
export async function boostHeatOnAccess(
  db: Db,
  campaignId: string,
  memoryId: string,
  category: string,
): Promise<void> {
  const boost =
    category === "relationship" ? BOOST_ON_ACCESS.relationship : BOOST_ON_ACCESS.default;
  await db
    .update(semanticMemories)
    .set({ heat: sql`LEAST(100, heat + ${boost})` })
    .where(and(eq(semanticMemories.id, memoryId), eq(semanticMemories.campaignId, campaignId)));
}
