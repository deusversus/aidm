import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, entities } from "@/lib/db/schema";
import { isProtagonistName } from "@/lib/entity-identity";
import { CLASSIFY } from "@/lib/llm/budgets";
import { callProbe } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import { DirectionState, type MergeSuggestion } from "@/lib/types/direction";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { mergeEntities } from "./merge";

/**
 * The janitor (§6.5, M2 C1): catalog hygiene as a system actor. Reviews the
 * live catalog for same-type near-duplicates the deterministic identity tier
 * can't see (different names, same meaning — the live exhibit: "Lloyd and
 * protagonist connection" vs "Path-Crossing with Lloyd").
 *
 * Two-stage per §14 risk-6 discipline: an embedding candidate FILTER (cheap,
 * generous) feeds a "same entity?" probe that DECIDES. Above MERGE_AUTO the
 * pair merges automatically (provenance merge:janitor); in the suggest band
 * it becomes a MergeSuggestion for the player (player word owns ambiguity);
 * below, silence. Runs failure-isolated at session close beside the Sakkan
 * sample; the mint-time resolver reuses pairLikelySame for its guard.
 */

/** Cosine distance ceiling for the candidate filter — generous; the probe decides. */
export const MERGE_CANDIDATE_MAX_DISTANCE = 0.35;
/** Probe confidence at/above which the janitor merges without asking. */
export const MERGE_AUTO_CONFIDENCE = 0.9;
/** Probe confidence at/above which an ambiguous pair is surfaced as a suggestion. */
export const MERGE_SUGGEST_CONFIDENCE = 0.55;
/** Probe budget per review (cheapest-first by distance) — no silent caps: a truncation warns. */
export const MERGE_MAX_PROBE_PAIRS = 10;
/** Block-head window each entry contributes to the "same?" probe. */
const PAIR_BLOCK_HEAD_CHARS = 300;

export interface JanitorReport {
  merged: Array<{ survivorId: string; dupeId: string; reason: string }>;
  suggested: MergeSuggestion[];
}

const PairVerdict = z.object({
  same: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const PAIR_SYSTEM = [
  "You are the catalog janitor for a collaborative story engine. Two catalog",
  "entries of the SAME type are given; decide whether they are one in-fiction",
  "entity that got minted twice under different phrasings, or two genuinely",
  "distinct entities.",
  "",
  'SAME means the identical in-fiction entity described twice — e.g. "Lloyd and',
  'the protagonist\'s connection" and "Path-Crossing with Lloyd" are the one',
  "thread. DISTINCT-BUT-RELATED is NOT same: a person and the faction they",
  "lead, two members of one family, a place and an event that happened there,",
  "a mentor and their student — these are different entities that merely relate,",
  "so answer same=false.",
  "",
  "confidence is your certainty that they are the SAME entity (0..1). reason is",
  "one sentence.",
].join(" ");

/**
 * One pair judgment: are these the same entity? Exposed for the resolver's
 * mint-time guard (ingest.ts) so both authorities share one definition of
 * "the same".
 */
export async function pairLikelySame(
  db: Db,
  selection: TierSelection,
  args: {
    campaignId: string;
    turnNumber: number;
    a: { id: string; name: string; entityType: string; block: string };
    b: { name: string; block: string };
  },
): Promise<{ same: boolean; confidence: number; reason: string }> {
  void db;
  const head = (s: string) => s.slice(0, PAIR_BLOCK_HEAD_CHARS).trim() || "(no description yet)";
  const prompt = [
    `Entity type: ${args.a.entityType}`,
    "",
    `ENTRY A — name: ${args.a.name}`,
    `description: ${head(args.a.block)}`,
    "",
    `ENTRY B — name: ${args.b.name}`,
    `description: ${head(args.b.block)}`,
    "",
    "Are ENTRY A and ENTRY B the same in-fiction entity described twice, or genuinely distinct?",
  ].join("\n");

  return callProbe(selection, {
    name: "entity_merge_pair",
    schema: PairVerdict,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    system: PAIR_SYSTEM,
    prompt,
    maxTokens: CLASSIFY,
  });
}

interface CatalogRow {
  id: string;
  name: string;
  entityType: string;
  block: string;
  /** Age proxy — entities carry no createdAt; the envelope turn is when the row entered the catalog. */
  turnId: number;
}

/**
 * Orient a pair for merge (§6.5): the OLDER row survives (keeps its id) so
 * inbound references stay valid; but when exactly one side is a protagonist
 * placeholder, the named/richer side survives so the PC keeps its real name.
 */
function chooseSurvivor(x: CatalogRow, y: CatalogRow): { survivor: CatalogRow; dupe: CatalogRow } {
  const xPlaceholder = isProtagonistName(x.name);
  const yPlaceholder = isProtagonistName(y.name);
  if (xPlaceholder !== yPlaceholder) {
    return xPlaceholder ? { survivor: y, dupe: x } : { survivor: x, dupe: y };
  }
  if (x.turnId !== y.turnId) {
    return x.turnId < y.turnId ? { survivor: x, dupe: y } : { survivor: y, dupe: x };
  }
  return x.id < y.id ? { survivor: x, dupe: y } : { survivor: y, dupe: x };
}

function samePair(
  a: { survivor_id: string; dupe_id: string },
  b: { survivor_id: string; dupe_id: string },
): boolean {
  return (
    (a.survivor_id === b.survivor_id && a.dupe_id === b.dupe_id) ||
    (a.survivor_id === b.dupe_id && a.dupe_id === b.survivor_id)
  );
}

export async function reviewCatalog(
  db: Db,
  campaignId: string,
  turnNumber: number,
  selection: TierSelection,
): Promise<JanitorReport> {
  const rows: CatalogRow[] = await db
    .select({
      id: entities.id,
      name: entities.name,
      entityType: entities.entityType,
      block: entities.block,
      turnId: entities.turnId,
    })
    .from(entities)
    .where(and(eq(entities.campaignId, campaignId), notTombstoned(entities)));

  // Group by type; candidate pairs only ever form within a type.
  const byType = new Map<string, CatalogRow[]>();
  for (const r of rows) {
    const g = byType.get(r.entityType);
    if (g) g.push(r);
    else byType.set(r.entityType, [r]);
  }

  interface Candidate {
    a: CatalogRow;
    b: CatalogRow;
    distance: number;
  }
  const candidates: Candidate[] = [];
  for (const group of byType.values()) {
    if (group.length < 2) continue;
    const embeddings = await embedTexts(
      group.map((e) => e.name),
      { inputType: "query", patience: "interactive", campaignId, turnNumber },
    );
    for (let i = 0; i < group.length; i++) {
      const ei = embeddings[i];
      const gi = group[i];
      if (!ei || !gi) continue;
      for (let j = i + 1; j < group.length; j++) {
        const ej = embeddings[j];
        const gj = group[j];
        if (!ej || !gj) continue;
        const distance = 1 - cosineSimilarity(ei, ej);
        if (distance < MERGE_CANDIDATE_MAX_DISTANCE) candidates.push({ a: gi, b: gj, distance });
      }
    }
  }

  candidates.sort((p, q) => p.distance - q.distance);
  const toProbe = candidates.slice(0, MERGE_MAX_PROBE_PAIRS);
  if (candidates.length > MERGE_MAX_PROBE_PAIRS) {
    console.warn(
      `[janitor] ${candidates.length} merge candidates exceed the ${MERGE_MAX_PROBE_PAIRS}-probe cap — reviewing the ${MERGE_MAX_PROBE_PAIRS} nearest, ${candidates.length - MERGE_MAX_PROBE_PAIRS} deferred to next close`,
    );
  }

  const report: JanitorReport = { merged: [], suggested: [] };
  const consumed = new Set<string>(); // ids tombstoned by an auto-merge this review
  const proposed: MergeSuggestion[] = [];

  for (const cand of toProbe) {
    if (consumed.has(cand.a.id) || consumed.has(cand.b.id)) continue;
    const verdict = await pairLikelySame(db, selection, {
      campaignId,
      turnNumber,
      a: { id: cand.a.id, name: cand.a.name, entityType: cand.a.entityType, block: cand.a.block },
      b: { name: cand.b.name, block: cand.b.block },
    });
    if (!verdict.same) continue;

    const { survivor, dupe } = chooseSurvivor(cand.a, cand.b);
    if (verdict.confidence >= MERGE_AUTO_CONFIDENCE) {
      await mergeEntities(db, {
        campaignId,
        survivorId: survivor.id,
        dupeId: dupe.id,
        provenance: "merge:janitor",
        turnId: turnNumber,
      });
      consumed.add(dupe.id);
      report.merged.push({ survivorId: survivor.id, dupeId: dupe.id, reason: verdict.reason });
    } else if (verdict.confidence >= MERGE_SUGGEST_CONFIDENCE) {
      proposed.push({
        survivor_id: survivor.id,
        dupe_id: dupe.id,
        survivor_name: survivor.name,
        dupe_name: dupe.name,
        entity_type: survivor.entityType,
        reason: verdict.reason,
        confidence: verdict.confidence,
        at_turn: turnNumber,
      });
    }
  }

  // Persist suggestions AFTER the merges (each merge cleaned direction_state of
  // its pair). Dedup against what's already there in either orientation, and
  // drop any suggestion whose entity an auto-merge just tombstoned. Inlined —
  // janitor stays off the ingest→janitor→director import cycle.
  if (proposed.length > 0) {
    // Read-modify-write under a row lock (C1 audit #1) so a concurrent
    // merge/dismiss can't be clobbered by this append.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${campaigns} WHERE ${campaigns.id} = ${campaignId} FOR UPDATE`,
      );
      const [campaignRow] = await tx
        .select({ directionState: campaigns.directionState })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId));
      const state = DirectionState.parse(campaignRow?.directionState ?? {});
      const existing = state.merge_suggestions;
      const additions: MergeSuggestion[] = [];
      for (const s of proposed) {
        if (consumed.has(s.survivor_id) || consumed.has(s.dupe_id)) continue;
        if (existing.some((e) => samePair(e, s))) continue;
        if (additions.some((a) => samePair(a, s))) continue;
        additions.push(s);
      }
      if (additions.length > 0) {
        const next = { ...state, merge_suggestions: [...existing, ...additions] };
        await tx
          .update(campaigns)
          .set({ directionState: next, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
        report.suggested = additions;
      }
    });
  }

  return report;
}
