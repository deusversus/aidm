import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, entities } from "@/lib/db/schema";
import { isProtagonistName } from "@/lib/entity-identity";
import { CLASSIFY } from "@/lib/llm/budgets";
import { callProbe } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import type { ModelCallPhase } from "@/lib/observability/meter";
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
 * generous) feeds a "same entity?" probe that DECIDES. The filter reads two
 * vectors — the NAME, and (M3R4 B3) name + block head for the pairs whose
 * wording shares nothing but whose meaning does. Above MERGE_AUTO the pair
 * merges automatically, provenance naming the tier that offered it
 * (merge:janitor / merge:janitor:semantic); in the suggest band
 * it becomes a MergeSuggestion for the player (player word owns ambiguity);
 * below, silence. Runs failure-isolated at session close beside the Sakkan
 * sample; the mint-time resolver reuses pairLikelySame for its guard.
 */

/** Cosine distance ceiling for the candidate filter — generous; the probe decides. */
export const MERGE_CANDIDATE_MAX_DISTANCE = 0.35;
/**
 * The SEMANTIC candidate tier (the M2 C1 deferral, landed M3R4 B3). The
 * verdict has always been semantic — `pairLikelySame` is a judged "same
 * in-fiction entity?" call, prompted with the doctrine — but the FILTER in
 * front of it embedded NAMES ALONE, so a pair that shares a meaning and no
 * wording ("the Red Sash syndicate" / "the dockworkers' syndicate") was never
 * offered to it. The second vector reads name + block head: what the entity IS,
 * not only what it is called.
 *
 * It cannot cost anything the name tier was already spending. Name candidates
 * keep their priority and their cheapest-first order; semantic ones fill only
 * the probe budget the name tier LEFT OVER, so the review's ceiling is the same
 * MERGE_MAX_PROBE_PAIRS it always was.
 *
 * THE NUMBER IS BORROWED AND KNOWN-PERMISSIVE (M3R4 B3 audit R2a). 0.35 was
 * measured against the NAME tier's distance distribution; dossier-head vectors
 * share a campaign's domain vocabulary, so their distances run systematically
 * SMALLER and the same ceiling is, as a candidacy net, wider by construction.
 * That is the intended posture and not a merge bar: this constant controls
 * CANDIDATE VOLUME only, the PROBE decides, and every merge it leads to carries
 * provenance and is rewindable. It stays untuned until a run measures it — the
 * probe log below is what a soak reads to tune it from data.
 */
export const MERGE_SEMANTIC_MAX_DISTANCE = 0.35;
/** Block head that joins the name in the semantic candidate vector. */
const SEMANTIC_VECTOR_BLOCK_CHARS = 300;
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

/**
 * NO RANGE BOUND on confidence (M3, after the 2026-08-01 live diagnosis): the
 * structured-output grammar strips `minimum`/`maximum` alongside the string
 * and array bounds, so `.min(0).max(1)` could not hold the probe to the band —
 * only fail the parse on a 1.2 and throw, taking the session-close review (or,
 * via pairLikelySame, the mint-time resolver guard) with it. The band is
 * stated in the prompt and pinned below; the verdict is read only through the
 * MERGE_AUTO/MERGE_SUGGEST thresholds, so pinning is lossless.
 */
export const PairVerdict = z.object({
  same: z.boolean(),
  confidence: z.number(),
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
    phase: ModelCallPhase;
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

  const verdict = await callProbe(selection, {
    name: "entity_merge_pair",
    schema: PairVerdict,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    phase: args.phase,
    system: PAIR_SYSTEM,
    prompt,
    maxTokens: CLASSIFY,
  });
  const confidence = Math.min(1, Math.max(0, verdict.confidence));
  if (confidence !== verdict.confidence) {
    console.warn("[janitor] pair confidence outside 0..1 — pinned to the band, verdict kept", {
      campaignId: args.campaignId,
      emitted: verdict.confidence,
      pinned: confidence,
    });
  }
  return { ...verdict, confidence };
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
  phase: ModelCallPhase = "turn",
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
    /** Which filter offered the pair — carried to the merge's provenance so a bad auto-merge is attributable. */
    tier: "name" | "semantic";
  }
  const candidates: Candidate[] = [];
  /** Pairs the NAME vector never brought forward, offered by meaning instead. */
  const semantic: Candidate[] = [];
  /** name + block head: what the entity IS, for the pairs its name hides. */
  const meaningText = (e: CatalogRow) =>
    `${e.name} — ${e.block.slice(0, SEMANTIC_VECTOR_BLOCK_CHARS).trim()}`.trim();
  for (const group of byType.values()) {
    if (group.length < 2) continue;
    const embedOpts = {
      inputType: "query" as const,
      patience: "interactive" as const,
      campaignId,
      turnNumber,
    };
    const embeddings = await embedTexts(
      group.map((e) => e.name),
      embedOpts,
    );
    // SEQUENCED, not concurrent (M3R4 B3 audit R1). Two reasons, both about
    // the new tier costing the shipped one nothing:
    //  · TPM — a 128-entity group's meaning texts run ~10K tokens, which is the
    //    whole keyless-tier minute budget; firing it alongside the name request
    //    burst-fails a pair the name filter alone would have handled. The
    //    janitor is a background close-time actor with no latency to protect,
    //    so the wait is free.
    //  · ISOLATION — a rejection here used to reject the Promise.all, which
    //    aborted reviewCatalog entirely and (via session.ts's catch) turned the
    //    whole hygiene pass into a silent no-op. Degrade instead: an empty
    //    vector list leaves every `meanings[i]` undefined, the loop below
    //    already skips those, and the name tier reviews untouched.
    const meanings = await embedTexts(group.map(meaningText), embedOpts).catch((err) => {
      console.warn("[janitor] meaning embed failed — the NAME tier reviews alone this close", {
        campaignId,
        entityType: group[0]?.entityType,
        groupSize: group.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as number[][];
    });
    for (let i = 0; i < group.length; i++) {
      const ei = embeddings[i];
      const gi = group[i];
      if (!ei || !gi) continue;
      for (let j = i + 1; j < group.length; j++) {
        const ej = embeddings[j];
        const gj = group[j];
        if (!ej || !gj) continue;
        const distance = 1 - cosineSimilarity(ei, ej);
        if (distance < MERGE_CANDIDATE_MAX_DISTANCE) {
          candidates.push({ a: gi, b: gj, distance, tier: "name" });
          continue;
        }
        // Different names — ask whether they mean the same thing.
        const mi = meanings[i];
        const mj = meanings[j];
        if (!mi || !mj) continue;
        const meaningDistance = 1 - cosineSimilarity(mi, mj);
        if (meaningDistance < MERGE_SEMANTIC_MAX_DISTANCE) {
          semantic.push({ a: gi, b: gj, distance: meaningDistance, tier: "semantic" });
        }
      }
    }
  }

  candidates.sort((p, q) => p.distance - q.distance);
  semantic.sort((p, q) => p.distance - q.distance);
  // Name candidates first, always: the semantic tier claims leftover budget and
  // never displaces a pair the shipped filter already found.
  const ranked = [...candidates, ...semantic];
  const toProbe = ranked.slice(0, MERGE_MAX_PROBE_PAIRS);
  if (ranked.length > MERGE_MAX_PROBE_PAIRS) {
    console.warn(
      `[janitor] ${ranked.length} merge candidates (${candidates.length} by name, ${semantic.length} by meaning) exceed the ${MERGE_MAX_PROBE_PAIRS}-probe cap — reviewing the ${MERGE_MAX_PROBE_PAIRS} nearest, ${ranked.length - MERGE_MAX_PROBE_PAIRS} deferred to next close`,
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
      phase,
      a: { id: cand.a.id, name: cand.a.name, entityType: cand.a.entityType, block: cand.a.block },
      b: { name: cand.b.name, block: cand.b.block },
    });
    // MEASUREMENT, not a fault (M3R4 B3 audit R2b) — on the janitor's only
    // logging channel so a soak captures it beside the rest. The semantic
    // tier's ceiling was set by borrowing the name tier's number; these lines
    // are the distance/verdict distribution that lets the next soak TUNE it,
    // rather than the constant staying a vibe forever.
    if (cand.tier === "semantic") {
      console.warn("[janitor] semantic-tier pair probed (threshold measurement)", {
        campaignId,
        turnNumber,
        entityType: cand.a.entityType,
        a: cand.a.name,
        b: cand.b.name,
        meaningDistance: Number(cand.distance.toFixed(4)),
        same: verdict.same,
        confidence: verdict.confidence,
      });
    }
    if (!verdict.same) continue;

    const { survivor, dupe } = chooseSurvivor(cand.a, cand.b);
    if (verdict.confidence >= MERGE_AUTO_CONFIDENCE) {
      await mergeEntities(db, {
        campaignId,
        survivorId: survivor.id,
        dupeId: dupe.id,
        // ATTRIBUTION (M3R4 B3 audit R2c): "merge:janitor" alone could not tell
        // a name-tier merge from a semantic-tier one, so a bad auto-merge from
        // the permissive new filter was indistinguishable in the record from
        // one the shipped filter made. The tier rides the provenance envelope.
        provenance: cand.tier === "semantic" ? "merge:janitor:semantic" : "merge:janitor",
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
