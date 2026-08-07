import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { seeds } from "@/lib/db/schema";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import {
  DIRECTOR_MAX_INTERVAL,
  type DirectorSeedOp,
  ORGANIC_CANDIDATE_THRESHOLD,
  OVERDUE_TENSION_BUMP,
  SEED_ADJUDICATION_CAPS,
  SEED_CONVERGENCE_MAX_PAIRS,
  SEED_CONVERGENCE_SIMILARITY,
  SEED_DEFAULT_URGENCY,
  SEED_DESCRIPTION_RENDER_CHARS,
  SEED_MAX_CANDIDATES,
  SEED_MAX_TURNS_TO_PAYOFF,
  SEED_MENTION_URGENCY_BUMP,
  SEED_MIN_TURNS_TO_PAYOFF,
  type SeedCandidate,
  parseCandidates,
} from "@/lib/types/direction";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * The seed ledger operations (blueprint §7.6, v3 foreshadowing.py carried):
 * plant/resolve/abandon/adjust_window/auto_resolve with payoff windows,
 * dependency gates, urgency, overdue→tension, convergence.
 *
 * Detection is TWO-PATH (§7.6). The DECLARED path lives in G2: the sidecar's
 * intended mentions confirmed by one bounded probe per turn. The ORGANIC path
 * is `sweepSeedCandidates` below — pure code, no model call: cosine of the
 * turn's narration against every open seed's stored description embedding.
 * Candidates are NOT mentions; they accumulate on the row and are adjudicated
 * in ONE batched judged call on Director cadence (direction/adjudication.ts).
 *
 * Statuses: planted | confirmed | resolved | abandoned.
 */

export type SeedRow = typeof seeds.$inferSelect;
/** The hot-path shape: everything but the 1024-dim vector (stack audit —
 *  callbackReadySeeds runs EVERY turn via retrieval and never reads it). */
export type SeedCore = Omit<
  SeedRow,
  "embedding" | "resolvedBy" | "turnId" | "provenance" | "confidence" | "tombstonedAt"
>;

const OPEN_STATUSES = ["planted", "confirmed"] as const;

/** The stored payoff window, defaulted from the plant turn when absent. */
export function windowOf(seed: SeedCore | SeedRow): { from: number; to: number } {
  const w = seed.payoffWindow as { from?: number; to?: number } | null;
  return {
    from: w?.from ?? seed.plantedTurn + SEED_MIN_TURNS_TO_PAYOFF,
    to: w?.to ?? seed.plantedTurn + SEED_MAX_TURNS_TO_PAYOFF,
  };
}

/** Stored dependency seed ids (jsonb string[]), guarded. */
function depsOf(seed: SeedCore | SeedRow): string[] {
  return Array.isArray(seed.dependencies) ? (seed.dependencies as string[]) : [];
}

/** The stored embedding as a plain vector, or undefined when never embedded. */
function embeddingOf(seed: SeedRow): number[] | undefined {
  const e = seed.embedding;
  return Array.isArray(e) && e.length > 0 ? e : undefined;
}

/**
 * Best single containment match (case-insensitive, bidirectional): a row
 * matches if its description contains the query or the query contains it;
 * ties break toward the closest length. The Director speaks prose, so
 * containment is how a spoken reference lands on a stored seed.
 *
 * The trailing ellipsis is STRIPPED first (M3R4 R-2, belt): anything that
 * renders a seed under a length bound leaves one behind, and a quoted "…"
 * defeats containment in BOTH directions — the stored text does not contain
 * the ellipsis, and the clipped quote does not contain the stored text. The
 * dossier no longer truncates (SEED_DESCRIPTION_RENDER_CHARS), so this is the
 * second line of defence, not the first: convergence pairs and dependency
 * lines are still rendered short, and the Director may quote either.
 */
function bestMatch(rows: SeedRow[], query: string): SeedRow | undefined {
  const q = query
    .trim()
    .replace(/(…|\.{3})$/, "")
    .trim()
    .toLowerCase();
  if (!q) return undefined;
  const matches = rows.filter((r) => {
    const d = r.description.trim().toLowerCase();
    return d.includes(q) || q.includes(d);
  });
  if (matches.length === 0) return undefined;
  // Deterministic tie-break on id: the feeding selects carry no ORDER BY, so
  // Postgres row order is unspecified — an equal-distance tie must not resolve
  // to a different seed run-to-run (C7 audit; crash-replay stays idempotent).
  matches.sort(
    (a, b) =>
      Math.abs(a.description.length - q.length) - Math.abs(b.description.length - q.length) ||
      a.id.localeCompare(b.id),
  );
  return matches[0];
}

/** Every open (planted|confirmed) seed for a campaign. */
export async function openSeeds(db: Db, campaignId: string): Promise<SeedRow[]> {
  return db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, [...OPEN_STATUSES]),
        notTombstoned(seeds),
      ),
    );
}

/**
 * Plant with envelope. Window defaults to
 * [plantedTurn + SEED_MIN_TURNS_TO_PAYOFF, plantedTurn + SEED_MAX_TURNS_TO_PAYOFF];
 * urgency defaults SEED_DEFAULT_URGENCY. `dependencies` arrive as
 * descriptions (the Director speaks prose) — matched to seed ids here;
 * unmatched dependencies are dropped with a returned note, never invented.
 *
 * The description is embedded HERE (§7.6): the organic sweep runs every turn
 * and must never pay for an embed it could have paid for once. A failed embed
 * is a warn and a null column — the sweep backfills it lazily — never a lost
 * plant.
 */
export async function plantSeed(
  db: Db,
  campaignId: string,
  turnNumber: number,
  op: DirectorSeedOp,
  provenance: string,
): Promise<{ seedId: string; notes: string[] }> {
  const description = op.description?.trim();
  if (!description) throw new Error("plantSeed: a plant op requires a description");

  const notes: string[] = [];
  // Dependency pool excludes ABANDONED seeds: the gate requires deps to reach
  // "resolved", which abandoned never does — a dependency bound to one gates
  // the new seed forever (C7 audit). Resolved seeds stay matchable: a dep on
  // an already-resolved seed is a legitimately open gate.
  const existing = await db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, ["planted", "confirmed", "resolved"]),
        notTombstoned(seeds),
      ),
    );

  const matchedIds: string[] = [];
  for (const dep of op.dependencies) {
    const match = bestMatch(existing, dep);
    if (match) {
      if (!matchedIds.includes(match.id)) matchedIds.push(match.id);
    } else {
      notes.push(`dependency "${dep}" matched no existing seed — dropped`);
    }
  }

  const from = op.payoff_window_from ?? turnNumber + SEED_MIN_TURNS_TO_PAYOFF;
  const to = op.payoff_window_to ?? turnNumber + SEED_MAX_TURNS_TO_PAYOFF;

  let embedding: number[] | undefined;
  try {
    const [vec] = await embedTexts([description], {
      inputType: "document",
      patience: "interactive",
      campaignId,
      turnNumber,
      phase: "director_cycle",
    });
    embedding = vec;
  } catch (err) {
    notes.push("seed description could not be embedded — organic sweep backfills it");
    console.warn(`[seeds] plant-time embed failed (turn ${turnNumber}) — backfilling later:`, err);
  }

  const [row] = await db
    .insert(seeds)
    .values({
      campaignId,
      description,
      expectedPayoff: op.expected_payoff ?? null,
      status: "planted",
      plantedTurn: turnNumber,
      payoffWindow: { from, to },
      urgency: SEED_DEFAULT_URGENCY,
      dependencies: matchedIds,
      mentionCount: 0,
      candidates: [],
      ...(embedding ? { embedding } : {}),
      turnId: turnNumber,
      provenance,
      confidence: 0.9,
    })
    .returning({ id: seeds.id });
  if (!row) throw new Error("plantSeed: insert returned nothing");

  return { seedId: row.id, notes };
}

/**
 * Settle by description match (case-insensitive containment, best single
 * match): resolve, abandon, or adjust_window (the push-out, C1-planned and
 * slipped: a window UPDATE IN PLACE, never a duplicate plant — the duplicate
 * is why the audit found seeds that could never leave the ledger).
 */
export async function settleSeed(
  db: Db,
  campaignId: string,
  turnNumber: number,
  op: DirectorSeedOp,
): Promise<{ seedId?: string; note?: string }> {
  const query = (op.seed_description ?? op.description ?? "").trim();
  if (!query) return { note: "settleSeed: no seed_description to match against" };

  const open = await openSeeds(db, campaignId);
  const match = bestMatch(open, query);
  if (!match) return { note: `settleSeed: no open seed matched "${query}"` };

  switch (op.op) {
    case "resolve":
      await db
        .update(seeds)
        .set({ status: "resolved", resolvedTurn: turnNumber, resolvedBy: "director" })
        .where(eq(seeds.id, match.id));
      return { seedId: match.id };
    case "adjust_window": {
      const current = windowOf(match);
      const adjusted = adjustedWindow(
        current,
        turnNumber,
        op.payoff_window_from,
        op.payoff_window_to,
      );
      if (!adjusted) {
        return { seedId: match.id, note: "adjust_window: no usable window — left as planted" };
      }
      await db.update(seeds).set({ payoffWindow: adjusted }).where(eq(seeds.id, match.id));
      return { seedId: match.id };
    }
    default:
      // abandon — dropped without a resolution turn.
      await db
        .update(seeds)
        .set({ status: "abandoned", resolvedBy: "director" })
        .where(eq(seeds.id, match.id));
      return { seedId: match.id };
  }
}

/**
 * Where a pushed-out window lands. `to` may never fall on or before the
 * current turn (that is an instantly-overdue seed, the very state the push-out
 * exists to clear) and never past the v3 horizon; `from` only moves when the
 * caller names it. Returns undefined when nothing usable was asked for.
 */
export function adjustedWindow(
  current: { from: number; to: number },
  turnNumber: number,
  from?: number,
  to?: number,
): { from: number; to: number } | undefined {
  if (from === undefined && to === undefined) return undefined;
  const nextFrom = from ?? current.from;
  const ceiling = turnNumber + SEED_MAX_TURNS_TO_PAYOFF;
  const nextTo = Math.min(ceiling, Math.max(to ?? current.to, turnNumber + 1, nextFrom));
  if (nextFrom === current.from && nextTo === current.to) return undefined;
  return { from: nextFrom, to: nextTo };
}

/**
 * auto_resolve by id: the judged payoff landed (§7.6). Distinct from a
 * Director-chosen resolve in `resolved_by` alone — the lifecycle end is the
 * same, but who decided it is a thing the ledger has to be able to answer.
 */
export async function autoResolveSeed(db: Db, seedId: string, turnNumber: number): Promise<void> {
  await db
    .update(seeds)
    .set({ status: "resolved", resolvedTurn: turnNumber, resolvedBy: "adjudicator_payoff" })
    .where(eq(seeds.id, seedId));
}

/** CONFLICT auto-abandonment (§7.6): the story contradicted this seed; let it go. */
export async function conflictAbandonSeed(db: Db, seedId: string): Promise<void> {
  await db
    .update(seeds)
    .set({ status: "abandoned", resolvedBy: "adjudicator_conflict" })
    .where(eq(seeds.id, seedId));
}

/** adjust_window by id — the push-out as an UPDATE. Returns the window it landed on. */
export async function adjustSeedWindow(
  db: Db,
  seed: SeedRow,
  turnNumber: number,
  to: number,
): Promise<{ from: number; to: number } | undefined> {
  const next = adjustedWindow(windowOf(seed), turnNumber, undefined, to);
  if (!next) return undefined;
  await db.update(seeds).set({ payoffWindow: next }).where(eq(seeds.id, seed.id));
  return next;
}

/**
 * Urgency-on-mention (§7.6): one confirmed mention, counter + urgency,
 * planted→confirmed. Takes any drizzle writer so G2's declared path can run it
 * inside its checkpoint transaction — one implementation, both detection
 * paths, so the two can never drift on what a mention costs the ledger.
 */
export type SeedWriter = Pick<Db, "update">;

export async function recordSeedMention(db: SeedWriter, seedId: string): Promise<void> {
  await db
    .update(seeds)
    .set({
      mentionCount: sql`${seeds.mentionCount} + 1`,
      urgency: sql`LEAST(1, ${seeds.urgency} + ${SEED_MENTION_URGENCY_BUMP})`,
      status: sql`CASE WHEN ${seeds.status} = 'planted' THEN 'confirmed' ELSE ${seeds.status} END`,
    })
    .where(eq(seeds.id, seedId));
}

/**
 * Callback-ready (v3 check_callback_ready): status planted|confirmed, past
 * the window's `from` (or SEED_MIN_TURNS_TO_PAYOFF after planting), and
 * every dependency seed RESOLVED (the gate). Ordered by urgency desc.
 * Layout surfaces these as conte callbacks (≤3, opportunities never
 * obligations).
 */
export async function callbackReadySeeds(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<SeedCore[]> {
  // Explicit columns: this runs EVERY turn via retrieval, and a bare select
  // drags each seed's 1024-dim vector across the wire for a reader that
  // never looks at it (stack audit). The sweep, which does, selects its own.
  const all = await db
    .select({
      id: seeds.id,
      campaignId: seeds.campaignId,
      description: seeds.description,
      expectedPayoff: seeds.expectedPayoff,
      status: seeds.status,
      plantedTurn: seeds.plantedTurn,
      payoffWindow: seeds.payoffWindow,
      urgency: seeds.urgency,
      dependencies: seeds.dependencies,
      mentionCount: seeds.mentionCount,
      resolvedTurn: seeds.resolvedTurn,
      candidates: seeds.candidates,
    })
    .from(seeds)
    .where(and(eq(seeds.campaignId, campaignId), notTombstoned(seeds)));
  const byId = new Map(all.map((s) => [s.id, s]));

  const ready = all.filter((seed) => {
    if (!(OPEN_STATUSES as readonly string[]).includes(seed.status)) return false;
    if (currentTurn < windowOf(seed).from) return false;
    // Dependency gate: every listed dependency must resolve first. A tombstoned
    // dependency is absent from byId → unresolved → gate holds.
    return depsOf(seed).every((depId) => byId.get(depId)?.status === "resolved");
  });

  ready.sort((a, b) => b.urgency - a.urgency);
  return ready;
}

/**
 * CLOSING (§7.6, M3R4 R-2): an open seed whose payoff window shuts within ONE
 * Director interval — so THIS cycle is plausibly the last one that can still
 * act on it. Derived from the window the ledger already stores and the cadence
 * constant the Director already runs on; nothing new is recorded anywhere.
 *
 * The failure mode it answers, measured on the N=50 soak: a seed was silent in
 * every channel until `currentTurn > window.to`, at which point it was already
 * OVERDUE — the promise was broken before anyone was asked about it. 13 of 19
 * seeds expired un-pushed, `adjust_window` was never used once, and no seed was
 * ever abandoned on purpose. A promise that can still be kept, pushed, or let
 * go deliberately is a different object from one the story has already run past.
 */
export function isClosing(seed: SeedCore | SeedRow, currentTurn: number): boolean {
  const { to } = windowOf(seed);
  return to >= currentTurn && to - currentTurn <= DIRECTOR_MAX_INTERVAL;
}

/** Open seeds past their window's `to` (v3 get_overdue_seeds). */
export async function overdueSeeds(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<SeedRow[]> {
  const open = await openSeeds(db, campaignId);
  return open.filter((seed) => currentTurn > windowOf(seed).to);
}

/** Overdue→tension (v3): bump = count * OVERDUE_TENSION_BUMP, caller caps at 1. */
export function overdueTensionBump(overdueCount: number): number {
  return overdueCount * OVERDUE_TENSION_BUMP;
}

// --- Organic detection (§7.6 — code, never a model call) ---------------------

/**
 * The per-turn organic sweep: embed this turn's narration ONCE and cosine it
 * against every open seed's stored description embedding. Hits at or above
 * ORGANIC_CANDIDATE_THRESHOLD accumulate on the seed row as CANDIDATES —
 * explicitly not mentions; only the batched adjudication may promote one.
 *
 * Seeds planted before M3 C2 (and any plant whose embed failed) backfill here,
 * lazily, in the same sweep. Idempotent: a candidate already recorded for this
 * turn is left alone, so a replayed G2 never double-counts.
 */
export async function sweepSeedCandidates(
  db: Db,
  campaignId: string,
  turnNumber: number,
  narration: string,
  opts: { alreadyMentioned?: string[] } = {},
): Promise<{ swept: number; candidates: number; backfilled: number }> {
  const prose = narration.trim();
  if (!prose) return { swept: 0, candidates: 0, backfilled: 0 };
  const all = await openSeeds(db, campaignId);
  // The two paths must not bill the same turn twice: a seed the declared probe
  // already confirmed on THIS scene would also read as a cosine hit, and the
  // batched adjudication would later count the candidate as a second mention.
  // The declared path is the stronger evidence (a judge read the page against
  // the seed), so it wins the turn outright.
  const skip = new Set(opts.alreadyMentioned ?? []);
  const open = all.filter((s) => !skip.has(s.id));
  if (open.length === 0) return { swept: 0, candidates: 0, backfilled: 0 };

  // Asymmetric embedding: the seed descriptions are the documents (embedded at
  // plant), this scene is the query asking which of them it just touched. Two
  // calls only when a backfill is due; the steady state is one.
  const missing = open.filter((s) => !embeddingOf(s));
  let backfilled = 0;
  if (missing.length > 0) {
    try {
      const vectors = await embedTexts(
        missing.map((s) => s.description),
        { inputType: "document", patience: "interactive", campaignId, turnNumber },
      );
      for (const [i, seed] of missing.entries()) {
        const vec = vectors[i];
        if (!vec) continue;
        await db.update(seeds).set({ embedding: vec }).where(eq(seeds.id, seed.id));
        seed.embedding = vec;
        backfilled++;
      }
    } catch (err) {
      console.warn(`[seeds] lazy embedding backfill failed (turn ${turnNumber}):`, err);
    }
  }

  const embedded = open.filter((s) => embeddingOf(s));
  if (embedded.length === 0) return { swept: 0, candidates: 0, backfilled };

  let narrationVec: number[] | undefined;
  try {
    const [vec] = await embedTexts([prose], {
      inputType: "query",
      patience: "interactive",
      campaignId,
      turnNumber,
    });
    narrationVec = vec;
  } catch (err) {
    console.warn(`[seeds] narration embed failed (turn ${turnNumber}) — sweep skipped:`, err);
    return { swept: 0, candidates: 0, backfilled };
  }
  if (!narrationVec) return { swept: 0, candidates: 0, backfilled };

  let candidates = 0;
  for (const seed of embedded) {
    const vec = embeddingOf(seed);
    if (!vec) continue;
    const similarity = cosineSimilarity(narrationVec, vec);
    if (similarity < ORGANIC_CANDIDATE_THRESHOLD) continue;
    const existing = parseCandidates(seed.candidates);
    if (existing.some((c) => c.t === turnNumber)) continue;
    const next = [...existing, { t: turnNumber, s: Number(similarity.toFixed(4)) }].slice(
      -SEED_MAX_CANDIDATES,
    );
    await db.update(seeds).set({ candidates: next }).where(eq(seeds.id, seed.id));
    candidates++;
  }
  return { swept: embedded.length, candidates, backfilled };
}

/** Candidates no batched adjudication has read yet — the only ones that cost. */
export function pendingCandidates(seed: SeedRow): SeedCandidate[] {
  return parseCandidates(seed.candidates).filter((c) => !c.adj);
}

/** Mark every stored candidate as read; the cost law forbids re-judging one. */
export async function markCandidatesAdjudicated(db: Db, seedId: string): Promise<void> {
  const [row] = await db.select().from(seeds).where(eq(seeds.id, seedId));
  if (!row) return;
  const marked = parseCandidates(row.candidates).map((c) => ({ ...c, adj: true }));
  await db.update(seeds).set({ candidates: marked }).where(eq(seeds.id, seedId));
}

// --- Convergence (§7.6 / §7.1 investigation — pure code) ---------------------

export interface SeedConvergence {
  a: SeedRow;
  b: SeedRow;
  /** Turns whose narration surfaced BOTH seeds — the story braiding them itself. */
  sharedTurns: number[];
  /** Mutual cosine of the two descriptions, when both are embedded. */
  similarity?: number;
}

/**
 * Two seeds converge when the story keeps touching them in the same scenes, or
 * when they were always the same thread wearing two descriptions. Both tests
 * are code: overlapping candidate turns, or descriptions at or above
 * SEED_CONVERGENCE_SIMILARITY. Ordered by overlap, then similarity.
 */
export function convergenceCandidates(rows: SeedRow[]): SeedConvergence[] {
  const open = rows.filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.status));
  const turnsById = new Map(
    open.map((s) => [s.id, new Set(parseCandidates(s.candidates).map((c) => c.t))]),
  );
  const found: SeedConvergence[] = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i];
      const b = open[j];
      if (!a || !b) continue;
      const shared = [...(turnsById.get(a.id) ?? [])]
        .filter((t) => turnsById.get(b.id)?.has(t))
        .sort((x, y) => x - y);
      const va = embeddingOf(a);
      const vb = embeddingOf(b);
      const similarity = va && vb ? cosineSimilarity(va, vb) : undefined;
      const close = similarity !== undefined && similarity >= SEED_CONVERGENCE_SIMILARITY;
      if (shared.length === 0 && !close) continue;
      found.push({
        a,
        b,
        sharedTurns: shared,
        ...(similarity !== undefined ? { similarity } : {}),
      });
    }
  }
  found.sort(
    (x, y) =>
      y.sharedTurns.length - x.sharedTurns.length || (y.similarity ?? 0) - (x.similarity ?? 0),
  );
  return found.slice(0, SEED_CONVERGENCE_MAX_PAIRS);
}

// --- The under-review set (§7.6 cost law) ------------------------------------

/** Why a seed is in front of the batched adjudicator this cycle. */
export interface SeedUnderReview {
  seed: SeedRow;
  pending: SeedCandidate[];
  callbackReady: boolean;
  overdue: boolean;
  /** Its window shuts within one Director interval — see {@link isClosing}. */
  closing: boolean;
}

/**
 * The ONLY seeds the batched call renders (§7.6: "cost scales with candidates,
 * never with ledger size"): seeds carrying un-adjudicated candidates, seeds
 * that are callback-ready AND carry an expected payoff to judge against,
 * CLOSING seeds whose window shuts within one Director interval, and overdue
 * seeds as conflict-suspects. Each bucket is capped; a seed in several buckets
 * appears once, wearing every tag it earned.
 */
export async function seedsUnderReview(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<SeedUnderReview[]> {
  const open = await openSeeds(db, campaignId);
  const ready = new Set(
    (await callbackReadySeeds(db, campaignId, currentTurn))
      .filter((s) => s.expectedPayoff?.trim())
      .slice(0, SEED_ADJUDICATION_CAPS.callback_ready)
      .map((s) => s.id),
  );
  const overdue = new Set(
    open
      .filter((s) => currentTurn > windowOf(s).to)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, SEED_ADJUDICATION_CAPS.conflict_suspects)
      .map((s) => s.id),
  );
  // The push-out's own bucket (M3R4 R-2): `extend` is the verdict that saves a
  // promise, and it was only ever offered on seeds already broken.
  const closing = new Set(
    open
      .filter((s) => isClosing(s, currentTurn))
      // Id tiebreak, this file's own idiom (:83-88): seeds planted in one op
      // share a window AND a default urgency, so without it the 6-cap boundary
      // is decided by row order Postgres never promised — the same ledger would
      // put a different seed in front of the adjudicator run to run.
      .sort(
        (a, b) =>
          windowOf(a).to - windowOf(b).to || b.urgency - a.urgency || a.id.localeCompare(b.id),
      )
      .slice(0, SEED_ADJUDICATION_CAPS.closing)
      .map((s) => s.id),
  );
  const withCandidates = open
    .map((seed) => ({ seed, pending: pendingCandidates(seed) }))
    .filter((x) => x.pending.length > 0)
    .sort((a, b) => bestSimilarity(b.pending) - bestSimilarity(a.pending))
    .slice(0, SEED_ADJUDICATION_CAPS.candidates);
  const candidateIds = new Map(withCandidates.map((x) => [x.seed.id, x.pending]));

  return open
    .filter(
      (s) => candidateIds.has(s.id) || ready.has(s.id) || overdue.has(s.id) || closing.has(s.id),
    )
    .map((seed) => ({
      seed,
      pending: candidateIds.get(seed.id) ?? [],
      callbackReady: ready.has(seed.id),
      overdue: overdue.has(seed.id),
      closing: closing.has(seed.id),
    }));
}

function bestSimilarity(candidates: SeedCandidate[]): number {
  return candidates.reduce((best, c) => Math.max(best, c.s), 0);
}

// --- The dossier (§7.1 investigation phase) ----------------------------------

/** Compact seed dossier for the Director's investigation (ids, status, windows, urgency, deps). */
export async function seedDossier(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<string> {
  // Bare select is DELIBERATE here: convergenceCandidates' similarity leg
  // reads the embeddings, and the dossier runs on Director cadence (every
  // 3-8 turns), not per-turn — the hot-path column discipline lives in
  // callbackReadySeeds (stack audit).
  const all = await db
    .select()
    .from(seeds)
    .where(and(eq(seeds.campaignId, campaignId), notTombstoned(seeds)));
  const byId = new Map(all.map((s) => [s.id, s]));

  const open = all
    .filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.status))
    .sort((a, b) => b.urgency - a.urgency);
  const resolved = all.filter((s) => s.status === "resolved").length;
  const abandoned = all.filter((s) => s.status === "abandoned").length;

  const trunc = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const lines: string[] = [`SEED LEDGER (turn ${currentTurn})`];
  // Cap open lines so the dossier stays ~30 lines for the Director prompt.
  let overdueCount = 0;
  let closingCount = 0;
  for (const seed of open.slice(0, 28)) {
    const w = windowOf(seed);
    const unmet = depsOf(seed)
      .map((id) => byId.get(id))
      .filter((dep) => dep?.status !== "resolved")
      .map((dep) => (dep ? trunc(dep.description, 30) : "?"));
    const deps = unmet.length ? `unmet-deps: ${unmet.join("; ")}` : "unmet-deps: none";
    // OVERDUE is marked per line, not just counted in the tension note: the
    // Director reads this ledger through get_seed_ledger too, and a seed the
    // story has run past is a different object than one still in its window.
    // CLOSING is the state BEFORE that (M3R4 R-2) — the last cycle at which a
    // push, a payoff or a deliberate abandonment is still keeping a promise
    // rather than apologizing for one.
    const late = currentTurn > w.to;
    const closing = !late && isClosing(seed, currentTurn);
    if (late) overdueCount++;
    if (closing) closingCount++;
    const marker = late ? " OVERDUE" : closing ? ` CLOSING (shuts in ${w.to - currentTurn})` : "";
    // The description is rendered WHOLE (M3R4 R-2): the Director settles seeds
    // by quoting this line back, and a truncation it quotes matches nothing.
    lines.push(
      `- "${trunc(seed.description, SEED_DESCRIPTION_RENDER_CHARS)}" [${seed.status}] urgency ${seed.urgency.toFixed(2)} ` +
        `window ${w.from}-${w.to}${marker} mentions ${seed.mentionCount} ${deps}`,
    );
  }
  if (open.length > 28) lines.push(`- …and ${open.length - 28} more open`);
  lines.push(`(${resolved} resolved, ${abandoned} abandoned)`);
  if (closingCount > 0) {
    lines.push(
      `${closingCount} CLOSING — their windows shut within ${DIRECTOR_MAX_INTERVAL} turns, and your cycles run at most that far apart, so this is plausibly your LAST cycle on them. Decide now, while the promise can still be kept: pay it, push it out with adjust_window (name the turn), or abandon it on purpose. Silence is the one answer that breaks it.`,
    );
  }
  if (overdueCount > 0) {
    lines.push(
      `${overdueCount} overdue → tension +${overdueTensionBump(overdueCount).toFixed(2)} (cap 1.0): pay them, escalate them, push the window out with adjust_window, or abandon them on purpose.`,
    );
  }

  const converging = convergenceCandidates(all);
  if (converging.length > 0) {
    lines.push("", "CONVERGENCE (the story is braiding these — consider paying them together)");
    for (const pair of converging) {
      const how = [
        pair.sharedTurns.length > 0 ? `shared scenes ${pair.sharedTurns.join(",")}` : "",
        pair.similarity !== undefined && pair.similarity >= SEED_CONVERGENCE_SIMILARITY
          ? `descriptions ${pair.similarity.toFixed(2)} similar`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(
        `- "${trunc(pair.a.description, 44)}" + "${trunc(pair.b.description, 44)}" (${how})`,
      );
    }
  }
  return lines.join("\n");
}
