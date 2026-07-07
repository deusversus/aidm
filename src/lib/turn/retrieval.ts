import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  canonChunks,
  criticalFacts,
  entities,
  heatBoosts,
  seeds,
  semanticMemories,
} from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import type { CanonChunk, ConteMemory } from "@/lib/types/conte";
import type { IntentOutput } from "@/lib/types/turn";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * The retrieval fan-out + heat economy read path (blueprint §6.4; v3
 * context_selector.py + memory.py values carried verbatim). Decay computes
 * at query time over TURN distance — no decay cron, no table rewrites.
 * Access boosts are recorded write-only here; Chronicler G2 applies them
 * as one batched UPDATE (C6).
 */

// --- Heat curves (v3 memory.py DECAY_CURVES + CATEGORY_DECAY, verbatim) ----

export const DECAY_CURVES = {
  none: 1.0,
  very_slow: 0.97,
  slow: 0.95,
  normal: 0.9,
  fast: 0.8,
  very_fast: 0.7,
} as const;
export type DecayCurve = keyof typeof DECAY_CURVES;

export const CATEGORY_DECAY: Record<string, DecayCurve> = {
  core: "none",
  character_state: "fast",
  relationship: "very_slow",
  quest: "normal",
  world_state: "normal",
  consequence: "slow",
  event: "normal",
  fact: "slow",
  npc_state: "normal",
  npc_interaction: "slow",
  location: "slow",
  episode: "very_fast",
  narrative_beat: "slow",
  session_zero: "none",
  session_zero_voice: "none",
};

/** v3: relationship boosts 30, everything else 20; heat caps at 100 (G2 applies). */
export function boostAmount(category: string): number {
  return category === "relationship" ? 30 : 20;
}

export const HOT_BASELINE_MIN_HEAT = 60;
export const HOT_BASELINE_LIMIT = 3;

/**
 * The query-time heat expression: floor'd exponential decay over turns
 * since last boost. Plot-critical rows pin to the "none" curve (v3
 * memory.py L131). SQL mirror of `computeHeat` below — the unit test
 * asserts the two agree.
 */
// Static SQL fragment — CATEGORY_DECAY is a compile-time dict, no injection surface.
const CATEGORY_CASE_SQL = Object.entries(CATEGORY_DECAY)
  .map(([cat, curve]) => `WHEN '${cat}' THEN ${DECAY_CURVES[curve]}`)
  .join(" ");

function heatExpr(currentTurn: number) {
  return sql<number>`GREATEST(
    ${semanticMemories.heatFloor},
    ${semanticMemories.baseHeat} * power(
      CASE WHEN ${semanticMemories.plotCritical} THEN 1.0 ELSE
        (CASE ${semanticMemories.category} ${sql.raw(CATEGORY_CASE_SQL)} ELSE ${DECAY_CURVES.normal} END)
      END,
      GREATEST(0, ${currentTurn} - ${semanticMemories.lastBoostedTurn})
    )
  )`;
}

/** TS mirror of the SQL heat expression, for tests and in-process use. */
export function computeHeat(
  row: {
    baseHeat: number;
    heatFloor: number;
    category: string;
    plotCritical: boolean;
    lastBoostedTurn: number;
  },
  currentTurn: number,
): number {
  const curve = row.plotCritical ? 1.0 : DECAY_CURVES[CATEGORY_DECAY[row.category] ?? "normal"];
  const turns = Math.max(0, currentTurn - row.lastBoostedTurn);
  return Math.max(row.heatFloor, row.baseHeat * curve ** turns);
}

// --- Multi-query decomposition (v3 context_selector L247-331) ---------------

export function decomposeQueries(
  intent: IntentOutput,
  playerInput: string,
  situation?: string,
): string[] {
  const queries: string[] = [];
  const action = [intent.action, intent.target].filter(Boolean).join(" ").trim();
  queries.push(action || playerInput);
  if (situation?.trim()) queries.push(situation.trim());
  if (intent.target) queries.push(`${intent.target} relationship history`);
  return [...new Set(queries.filter((q) => q.length > 0))].slice(0, 3);
}

// --- Candidate search: pgvector ANN + keyword hybrid ------------------------

export interface MemoryCandidate {
  id: string;
  content: string;
  category: string;
  score: number;
  heat: number;
  layer: string;
  turnId: number;
  provenance: string;
  confidence: number;
}

function toVec(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Fetch 2× the tier budget of semantic candidates across ≤3 queries, dedup
 * by content head keeping best score, then append the hot-baseline channel
 * (top-3 computed heat ≥60 — "what this campaign keeps returning to") at
 * lowest priority. v3's exact shape.
 */
export async function fetchCandidates(
  db: Db,
  campaignId: string,
  currentTurn: number,
  queries: string[],
  budget: number,
): Promise<MemoryCandidate[]> {
  if (budget <= 0 || queries.length === 0) return [];
  const fetchTotal = budget * 2;
  const perQuery = Math.max(3, Math.floor(fetchTotal / queries.length) + 1);
  const embeddings = await embedTexts(queries, { inputType: "query", patience: "interactive" });

  const heat = heatExpr(currentTurn);
  const byKey = new Map<string, MemoryCandidate>();
  for (const [qi, emb] of embeddings.entries()) {
    const vec = toVec(emb);
    const query = queries[qi] ?? "";
    // Keyword-hybrid: +0.25 when content matches the query terms (v3 L347).
    const rows = await db
      .select({
        id: semanticMemories.id,
        content: semanticMemories.content,
        category: semanticMemories.category,
        turnId: semanticMemories.turnId,
        provenance: semanticMemories.provenance,
        confidence: semanticMemories.confidence,
        heat,
        score: sql<number>`
          LEAST(1.0,
            (1 - (${semanticMemories.embedding} <=> ${vec}::vector))
            + CASE WHEN ${semanticMemories.content} ILIKE ${`%${query.slice(0, 60)}%`} THEN 0.25 ELSE 0 END
            + CASE WHEN ${semanticMemories.plotCritical} THEN 0.3 ELSE 0 END
            + CASE WHEN ${semanticMemories.category} = 'episode' THEN 0.15 ELSE 0 END
          )`,
      })
      .from(semanticMemories)
      .where(and(eq(semanticMemories.campaignId, campaignId), notTombstoned(semanticMemories)))
      .orderBy(sql`${semanticMemories.embedding} <=> ${vec}::vector`)
      .limit(perQuery);
    for (const r of rows) {
      const key = r.content.slice(0, 100);
      const existing = byKey.get(key);
      if (!existing || r.score > existing.score) {
        byKey.set(key, { ...r, layer: "semantic" });
      }
    }
  }
  const candidates = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, fetchTotal);

  // Hot baseline, appended LAST so it fills gaps without displacing hits.
  const hot = await db
    .select({
      id: semanticMemories.id,
      content: semanticMemories.content,
      category: semanticMemories.category,
      turnId: semanticMemories.turnId,
      provenance: semanticMemories.provenance,
      confidence: semanticMemories.confidence,
      heat,
    })
    .from(semanticMemories)
    .where(and(eq(semanticMemories.campaignId, campaignId), notTombstoned(semanticMemories)))
    .orderBy(desc(heat))
    .limit(HOT_BASELINE_LIMIT);
  const seen = new Set(candidates.map((c) => c.content.slice(0, 100)));
  for (const h of hot) {
    if (h.heat >= HOT_BASELINE_MIN_HEAT && !seen.has(h.content.slice(0, 100))) {
      candidates.push({ ...h, score: 0, layer: "hot_baseline" });
    }
  }
  return candidates;
}

// --- Relevance filter (v3 memory_ranker, carried) ----------------------------

export const RANK_FLOOR = 0.4;
export const FILTER_CAP = 5;

const RankOutput = z.object({
  scores: z
    .array(z.object({ index: z.number().int().min(0), score: z.number().min(0).max(1) }))
    .default([]),
});

/**
 * Judgment re-rank against the current situation. Skip conditions carried
 * from v3: ≤3 candidates, or system-command intents. On skip (or ranker
 * failure) candidates pass through capped — never block the turn on the
 * filter.
 */
export async function relevanceFilter(
  selection: TierSelection,
  candidates: MemoryCandidate[],
  intent: IntentOutput,
  playerInput: string,
  ctx: { campaignId: string; turnNumber: number },
): Promise<MemoryCandidate[]> {
  const systemCommand =
    intent.intent === "META_FEEDBACK" ||
    intent.intent === "OVERRIDE_COMMAND" ||
    intent.intent === "OP_COMMAND";
  if (candidates.length <= 3 || systemCommand) {
    return candidates.slice(0, FILTER_CAP);
  }
  try {
    const ranked = await callJudgment(selection, {
      name: "relevance_filter",
      schema: RankOutput,
      campaignId: ctx.campaignId,
      turnNumber: ctx.turnNumber,
      system: [
        "You are the memory ranker: select which past memories matter for the",
        "CURRENT situation. Semantic search retrieved candidates; some are",
        "keyword noise. Rate each 0.0 (irrelevant) to 1.0 (critical).",
        "HIGH (0.8-1.0): directly related to current entities, goals, or",
        "immediate context. MEDIUM (0.5-0.7): thematic relevance or useful",
        "background. LOW (0.0-0.4): noise, wrong timeline, irrelevant fact.",
        "Return a score for every index.",
      ].join(" "),
      prompt: [
        `CURRENT ACTION: ${playerInput}`,
        `INTENT: ${intent.intent}${intent.target ? ` → ${intent.target}` : ""}`,
        "",
        "CANDIDATES:",
        ...candidates.map((c, i) => `${i}. [${c.category}] ${c.content.slice(0, 300)}`),
      ].join("\n"),
      maxTokens: 2_000,
    });
    const scoreByIndex = new Map(ranked.scores.map((s) => [s.index, s.score]));
    return candidates
      .map((c, i) => ({ c, score: scoreByIndex.get(i) ?? 0 }))
      .filter((x) => x.score > RANK_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, FILTER_CAP)
      .map((x) => x.c);
  } catch (err) {
    console.warn("[layout] relevance filter failed — passing candidates through", err);
    return candidates.slice(0, FILTER_CAP);
  }
}

// --- Canon intent-mapped retrieval (v3 INTENT_LORE_CONFIG) -------------------

const INTENT_LORE_CONFIG: Record<string, { pageType: string | null; limit: number }> = {
  COMBAT: { pageType: null, limit: 3 },
  ABILITY: { pageType: "techniques", limit: 3 },
  SOCIAL: { pageType: "characters", limit: 2 },
  EXPLORATION: { pageType: "locations", limit: 2 },
  INVENTORY: { pageType: "items", limit: 2 },
  WORLD_BUILDING: { pageType: null, limit: 3 },
  DEFAULT: { pageType: null, limit: 2 },
};

export async function fetchCanon(
  db: Db,
  profileIds: string[],
  intent: IntentOutput,
  queryText: string,
  fanOut: boolean,
): Promise<CanonChunk[]> {
  if (profileIds.length === 0 || !queryText.trim()) return [];
  let config = INTENT_LORE_CONFIG[intent.intent] ?? INTENT_LORE_CONFIG.DEFAULT;
  // Ambiguity handling (v3 L152-162): low confidence + secondary → broaden.
  if (intent.confidence < 0.7 && intent.secondary_intent) {
    const secondary = INTENT_LORE_CONFIG[intent.secondary_intent] ?? INTENT_LORE_CONFIG.DEFAULT;
    config = {
      pageType: config?.pageType && secondary?.pageType ? config.pageType : null,
      limit: Math.max(config?.limit ?? 2, secondary?.limit ?? 2),
    };
  }
  if (!config) return [];
  const limit = Math.min(fanOut ? 3 : config.limit, 3);
  const [emb] = await embedTexts([queryText], { inputType: "query", patience: "interactive" });
  if (!emb) return [];
  const vec = toVec(emb);
  const rows = await db
    .select({
      profileId: canonChunks.profileId,
      pageType: canonChunks.pageType,
      content: canonChunks.content,
    })
    .from(canonChunks)
    .where(
      and(
        inArray(canonChunks.profileId, profileIds),
        notTombstoned(canonChunks),
        // Sakuga fan-out drops the page-type constraint (broad canon read).
        ...(config.pageType && !fanOut ? [eq(canonChunks.pageType, config.pageType)] : []),
      ),
    )
    .orderBy(sql`${canonChunks.embedding} <=> ${vec}::vector`)
    .limit(limit);
  return rows.map((r) => ({
    source_profile_id: r.profileId,
    page_type: r.pageType,
    content: r.content,
  }));
}

// --- Entity cards, callbacks, hard core --------------------------------------

/** Catalog entities named in the input (thin M1 presence detection). */
export async function fetchEntityCards(
  db: Db,
  campaignId: string,
  playerInput: string,
  cap = 4,
): Promise<string[]> {
  const rows = await db
    .select({ name: entities.name, block: entities.block, entityType: entities.entityType })
    .from(entities)
    .where(and(eq(entities.campaignId, campaignId), notTombstoned(entities)));
  const input = playerInput.toLowerCase();
  return rows
    .filter((r) => input.includes(r.name.toLowerCase()))
    .slice(0, cap)
    .map((r) => `${r.name} (${r.entityType}): ${r.block}`);
}

/** Seeds inside their payoff window (or urgent) surface as callback opportunities (≤3). */
export async function fetchCallbacks(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<string[]> {
  const rows = await db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, ["planted", "confirmed"]),
        notTombstoned(seeds),
      ),
    );
  return rows
    .filter((s) => {
      const w = s.payoffWindow as { from?: number; to?: number } | null;
      const inWindow = w?.from !== undefined && currentTurn >= w.from;
      return inWindow || s.urgency > 0;
    })
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 3)
    .map(
      (s) => `${s.description}${s.expectedPayoff ? ` (expected payoff: ${s.expectedPayoff})` : ""}`,
    );
}

/** Critical facts — guaranteed include, every tier including douga (§5.4). */
export async function fetchCritical(db: Db, campaignId: string): Promise<string[]> {
  const rows = await db
    .select({ content: criticalFacts.content })
    .from(criticalFacts)
    .where(and(eq(criticalFacts.campaignId, campaignId), notTombstoned(criticalFacts)));
  return rows.map((r) => r.content);
}

// --- Boost accumulation (write-only until C6's G2 UPDATE binds) --------------

export async function recordBoosts(
  db: Db,
  campaignId: string,
  turnNumber: number,
  memories: MemoryCandidate[],
): Promise<void> {
  const semantic = memories.filter((m) => m.layer === "semantic" || m.layer === "hot_baseline");
  if (semantic.length === 0) return;
  await db.insert(heatBoosts).values(
    semantic.map((m) => ({
      campaignId,
      memoryId: m.id,
      boost: boostAmount(m.category),
      turnNumber,
    })),
  );
}

export function toConteMemories(memories: MemoryCandidate[]): ConteMemory[] {
  return memories.slice(0, FILTER_CAP).map((m) => ({
    content: m.content,
    layer: m.layer,
    turn_id: m.turnId,
    provenance: m.provenance,
    confidence: m.confidence,
  }));
}
