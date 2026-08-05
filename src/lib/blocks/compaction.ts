import { stripDirectiveFences } from "@/lib/client/plain-prose";
import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { compactedBeats, episodicRecords } from "@/lib/db/schema";
import { STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { and, asc, count, eq, gt, inArray, max } from "drizzle-orm";
import { z } from "zod";
import type { BeatRow, ExchangeRow } from "./assemble";
import { approxTokens } from "./tokens";

/**
 * The compaction event (blueprint §5.6, §6.2) — the ONLY sanctioned
 * invalidation of blocks 2–3. Fires every ~10 turns or at the window token
 * ceiling; truncates Block 3's oldest exchanges by writing narrated beats
 * to Block 2 and advancing the watermark. A per-turn sliding window is
 * unrepresentable here: the working window is DERIVED as "episodic records
 * past the last compacted turn", so nothing can slide without a compaction
 * event writing beats first.
 *
 * The compactor itself (subtext-first narrated beats, §6.2) is Compositor
 * craft that lands at M1; `naiveCompactor` is the M0 stub that keeps the
 * event contract executable and testable.
 */

/**
 * §6.2's ~12-exchange target — now the FLOOR of the oscillation rather than
 * its midpoint (see COMPACTION_KEEP_TAIL below), so a window at target is a
 * window that just compacted.
 */
export const WINDOW_MAX_EXCHANGES = 12;
/**
 * The verbatim window's token ceiling. 16k → 32k, USER-RULED 2026-08-05.
 *
 * WHY (M3R2's founding complaint, "each reply seems disparate — not the same
 * writer"): the pen's own recent hand is the strongest voice-consistency
 * pressure in the prompt, and 16k could not hold it. On the player's real
 * scene lengths (~2k tokens/scene, measured) the tail collapsed to the
 * 4-exchange floor and compaction fired every ~3 turns — past that line voice
 * memory was beats written under "discard choreography." 10–12 turns is the
 * ruled voice-consistency sweet spot; 32k is exactly double, which holds
 * 10–12 DEEP scenes verbatim and 12–15 typical ones. Quality outranks cost
 * (axiom): ~+$0.01/turn warm, and the cache carries it.
 */
export const WINDOW_MAX_TOKENS = 32_000;
export const BLOCK2_CEILING_TOKENS = 8_000;

/** Beats-writer signature; M1's Compositor supplies the narrated version. */
export type Compactor = (exchanges: ExchangeRow[]) => Promise<string[]>;

/** M0 stub: one clipped beat per exchange. Superseded by `judgmentCompactor` at M1. */
export const naiveCompactor: Compactor = async (exchanges) =>
  exchanges.map((e) => `(t${e.turnNumber}) ${stripDirectiveFences(e.narration).slice(0, 200)}`);

/**
 * The real M1 compactor (§6.2, subtext-first doctrine): ONE judgment-tier
 * call over the stretch of exchanges leaving the working window, narrating
 * what the stretch MEANT — motives, shifts, debts, what changed between the
 * characters — never a play-by-play. 2–4 beats, each ≤120 words. These beats
 * become the compacted history the KA reads (Block 2) in place of the
 * verbatim turns, so the pressure is on meaning, not recital.
 */
export const COMPACT_BEATS_MAX = 4;

/**
 * NO LENGTH BOUNDS (M3, after the 2026-08-01 live diagnosis): the structured-
 * output grammar strips `minItems`/`maxItems`/`minLength`, so a bound here
 * could not hold the compactor to four beats — only fail the parse on a fifth
 * and throw the compaction event itself, which at 100-turn scale is the window
 * that never truncates. The count is stated in the prompt (twice) and applied
 * in `judgmentCompactor`; blanks are filtered there too.
 */
export const CompactBeats = z.object({
  beats: z.array(z.string()),
});

export function judgmentCompactor(
  selection: TierSelection,
  ctx: { campaignId: string; turnNumber: number },
): Compactor {
  return async (exchanges) => {
    const transcript = exchanges
      // M3-DG: the summarizer reads story, not chrome — same projection as
      // the Sakkan and pins (the plan's §1 promise, audited true).
      .map(
        (e) =>
          `[Turn ${e.turnNumber}]\nPlayer: ${e.playerInput}\n\n${stripDirectiveFences(e.narration)}`,
      )
      .join("\n\n");
    const result = await callJudgment(selection, {
      name: "compact_beats",
      schema: CompactBeats,
      campaignId: ctx.campaignId,
      turnNumber: ctx.turnNumber,
      effort: "high",
      maxTokens: STRUCTURED_RICH,
      system: [
        "You are the Chronicler's compactor. Compress this stretch of play into",
        "2–4 narrated beats, SUBTEXT-FIRST: say what the stretch MEANT — the",
        "motives that surfaced, the way relationships shifted, the debts and",
        "prices incurred, what is now true that was not before — NOT a",
        "play-by-play of who did what. Each beat is at most 120 words, past",
        "tense, in the story's own register. These beats replace the verbatim",
        "turns in the writer's memory: preserve meaning, discard choreography.",
        `Emit at most ${COMPACT_BEATS_MAX} beats — any beyond the fourth are`,
        "discarded unread, so put the meaning in the ones you write.",
      ].join(" "),
      prompt: `Compact this stretch into 2–4 subtext-first beats:\n\n${transcript}`,
    });
    const beats = result.beats.map((b) => b.trim()).filter((b) => b.length > 0);
    if (beats.length > COMPACT_BEATS_MAX) {
      console.warn(
        `[compaction] compactor emitted ${beats.length} beats over its ${COMPACT_BEATS_MAX} ceiling — clamped, event kept`,
        { campaignId: ctx.campaignId, turnNumber: ctx.turnNumber },
      );
    }
    return beats.slice(0, COMPACT_BEATS_MAX);
  };
}

/** The watermark is derived, not stored: the last turn already compacted into Block 2. */
export async function compactionWatermark(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ toTurn: max(compactedBeats.toTurn) })
    .from(compactedBeats)
    .where(and(eq(compactedBeats.campaignId, campaignId), notTombstoned(compactedBeats)));
  return row?.toTurn ?? 0;
}

/** The Block 3 working window: everything past the watermark, in order. */
export async function workingWindow(db: Db, campaignId: string): Promise<ExchangeRow[]> {
  const watermark = await compactionWatermark(db, campaignId);
  const rows = await db
    .select()
    .from(episodicRecords)
    .where(
      and(
        eq(episodicRecords.campaignId, campaignId),
        gt(episodicRecords.turnNumber, watermark),
        notTombstoned(episodicRecords),
      ),
    )
    .orderBy(asc(episodicRecords.turnNumber));
  return rows.map((r) => ({
    turnNumber: r.turnNumber,
    playerInput: r.playerInput,
    narration: r.narration,
  }));
}

export async function loadBeats(db: Db, campaignId: string): Promise<BeatRow[]> {
  const rows = await db
    .select()
    .from(compactedBeats)
    .where(and(eq(compactedBeats.campaignId, campaignId), notTombstoned(compactedBeats)))
    // Ties on position break on id, never on row order: an epoch summary is
    // inserted AT its merged span's position, so Block 2's byte order has to
    // be a function of the rows alone (§5.6 — a reshuffled B2 is an
    // unsanctioned invalidation).
    .orderBy(asc(compactedBeats.position), asc(compactedBeats.id));
  return rows.map((r) => ({ position: r.position, content: r.content, isEpoch: r.isEpoch }));
}

export function shouldCompact(
  window: ExchangeRow[],
  limits = { maxExchanges: WINDOW_MAX_EXCHANGES, maxTokens: WINDOW_MAX_TOKENS },
): boolean {
  if (window.length > limits.maxExchanges) return true;
  const tokens = window.reduce(
    (sum, e) => sum + approxTokens(e.playerInput) + approxTokens(e.narration),
    0,
  );
  return tokens > limits.maxTokens;
}

export interface CompactionReport {
  compacted: boolean;
  /** Exchanges moved out of the window. */
  exchangesCompacted: number;
  beatsWritten: number;
  /** The accepted blocks-2/3 invalidation, accounted for §10.8's cache assertions. */
  b3TokensTruncated: number;
  b2TokensAfter: number;
  /**
   * STILL over the §6.2 ceiling after this event's epoch merges — i.e. the
   * merge was refused or failed. Loud, never silent: the next G2 retries.
   */
  epochMergeDue: boolean;
  /** Epoch merges run this event (§6.2); each is a sanctioned B2 rewrite. */
  epochMerges: number;
  /** Live beat rows folded into epoch summaries — tombstoned, never deleted (§6.7). */
  beatsMerged: number;
  /** Highest epoch level written this event; 0 = none, 2+ = an epoch of epochs. */
  epochLevel: number;
}

/**
 * The report for an event that wrote nothing — the four early-outs share it so
 * a new field can't be added to three of them.
 */
function noChangeReport(b2TokensAfter: number): CompactionReport {
  return {
    compacted: false,
    exchangesCompacted: 0,
    beatsWritten: 0,
    b3TokensTruncated: 0,
    b2TokensAfter,
    epochMergeDue: b2TokensAfter > BLOCK2_CEILING_TOKENS,
    epochMerges: 0,
    beatsMerged: 0,
    epochLevel: 0,
  };
}

async function block2Tokens(db: Db, campaignId: string): Promise<number> {
  const beats = await loadBeats(db, campaignId);
  return beats.reduce((s, b) => s + approxTokens(b.content), 0);
}

/**
 * Run one compaction event: move the oldest exchanges (all but the most
 * recent `keepTail`) into Block 2 as beats. Idempotent per watermark — a
 * crashed run that wrote beats has advanced the watermark, so a re-run
 * compacts only what remains.
 */
export async function runCompaction(
  db: Db,
  campaignId: string,
  turnId: number,
  opts: { compactor?: Compactor; keepTail?: number; provenance?: string } = {},
): Promise<CompactionReport> {
  const compactor = opts.compactor ?? naiveCompactor;
  const keepTail = opts.keepTail ?? 4;
  const provenance = opts.provenance ?? "compaction_event";
  const window = await workingWindow(db, campaignId);
  const toCompact = window.slice(0, Math.max(0, window.length - keepTail));
  if (toCompact.length === 0) {
    return noChangeReport(await block2Tokens(db, campaignId));
  }

  const beatTexts = await compactor(toCompact);
  if (beatTexts.length === 0) {
    // A compactor that produced nothing must not advance the watermark: the
    // window is DERIVED from the beats, so writing zero rows and reporting
    // success would silently drop the stretch out of the writer's memory. The
    // window stays over-long for one more turn and the next event retries.
    console.warn("[compaction] compactor produced no beats — window kept, event deferred", {
      campaignId,
      exchanges: toCompact.length,
    });
    return noChangeReport(await block2Tokens(db, campaignId));
  }
  const existing = await loadBeats(db, campaignId);
  let position = (existing.at(-1)?.position ?? -1) + 1;
  const first = toCompact[0];
  const last = toCompact.at(-1);
  if (!first || !last) throw new Error("unreachable: toCompact is non-empty");
  await db.insert(compactedBeats).values(
    beatTexts.map((content) => ({
      campaignId,
      content,
      isEpoch: false,
      fromTurn: first.turnNumber,
      toTurn: last.turnNumber,
      position: position++,
      turnId,
      provenance,
      confidence: 1,
    })),
  );

  const b3TokensTruncated = toCompact.reduce(
    (s, e) => s + approxTokens(e.playerInput) + approxTokens(e.narration),
    0,
  );
  const b2TokensAfter = await block2Tokens(db, campaignId);
  return {
    ...noChangeReport(b2TokensAfter),
    compacted: true,
    exchangesCompacted: toCompact.length,
    beatsWritten: beatTexts.length,
    b3TokensTruncated,
  };
}

// ---------------------------------------------------------------------------
// The epoch merge (§6.2) — Block 2 earns its ceiling
// ---------------------------------------------------------------------------

/**
 * §6.2, verbatim: "Block 2 ceiling: 8k tokens. On overflow, the oldest 50% of
 * beats re-compact into an epoch summary (≤1.5k tokens per ~50 turns),
 * replacing them" — hierarchical summarization, never v3's silent FIFO
 * eviction. The evicted DETAIL is not lost: those turns live verbatim in
 * episodic and distilled in semantic, and the beats themselves are tombstoned,
 * never deleted (§6.7 — a rewind past the merge must still find them).
 *
 * THE MARKER IS `is_epoch` + `provenance`, NOT A NEW COLUMN (deliberate, M3
 * C3). The depth of the hierarchy rides the provenance string
 * (`epoch_merge_l2` = an epoch of epochs) because Drizzle's `select()` names
 * every schema column: a column added here but not yet migrated makes EVERY
 * reader of compacted_beats error until the migration lands, which would take
 * the whole compaction/compositor/turn suite red on an unmigrated machine.
 * Provenance already answers "which writer, in what mode" — the level is a
 * mode. If depth ever needs indexing, that is a migration with a reader.
 */
export const EPOCH_TARGET_TOKENS = 1_500;

/**
 * Below two live beats there is no "oldest 50%" to fold: one beat over the
 * ceiling has nothing to merge WITH, and merging it with itself would loop.
 * This is the recursion's floor — see `enforceBlock2Ceiling` for the math.
 */
export const EPOCH_MIN_MERGE_BEATS = 2;

/**
 * Merges attempted per G2 event. The common overflow needs exactly one (an 8k
 * Block 2 halves to ~4k + a ≤1.5k epoch); the cap bounds the pathological case
 * — a campaign restored from a fat backfill — to three judgment calls in one
 * turn's G2 rather than a dozen. What the cap does NOT do is hide the state:
 * a Block 2 still over the ceiling when the cap is hit warns loudly and the
 * next G2 continues the work.
 */
export const EPOCH_MAX_MERGES_PER_EVENT = 3;

const EPOCH_PROVENANCE = "epoch_merge_l";

/** A live Block-2 row as the merge sees it — content plus the span it stands for. */
export interface EpochCandidate {
  id: string;
  position: number;
  content: string;
  fromTurn: number;
  toTurn: number;
  turnId: number;
  isEpoch: boolean;
  provenance: string;
}

/** An epoch's place in the hierarchy: 0 = a plain beat, 1 = an epoch, 2 = an epoch of epochs. */
export function epochLevelOf(row: Pick<EpochCandidate, "isEpoch" | "provenance">): number {
  if (!row.isEpoch) return 0;
  const parsed = new RegExp(`^${EPOCH_PROVENANCE}(\\d+)$`).exec(row.provenance);
  const level = parsed?.[1] ? Number(parsed[1]) : Number.NaN;
  // An epoch row whose provenance predates the convention still counts as an
  // epoch — level 1, the floor — rather than reading as a plain beat.
  return Number.isFinite(level) && level > 0 ? level : 1;
}

/**
 * The oldest 50% by position (§6.2), with a floor of two rows: a merge must
 * replace at least two live rows with one, or it makes no progress and the
 * recursion would not terminate. Returns [] when the floor cannot be met.
 */
export function selectEpochSpan(beats: EpochCandidate[]): EpochCandidate[] {
  if (beats.length < EPOCH_MIN_MERGE_BEATS) return [];
  const ordered = [...beats].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const half = Math.max(EPOCH_MIN_MERGE_BEATS, Math.floor(ordered.length / 2));
  return ordered.slice(0, Math.min(half, ordered.length));
}

/** Writes one epoch summary over a span of beats; the judgment-tier version is below. */
export type EpochSummarizer = (span: EpochCandidate[]) => Promise<string>;

export const EpochSummary = z.object({ summary: z.string() });

/**
 * The §6.2 epoch summarist: ONE judgment-tier call over the era leaving Block
 * 2, in the compactor's own subtext-first register (these beats were written
 * that way; the epoch is the same craft one altitude up — an era's meaning,
 * not a chronicle of it). No length bound in the schema for the same reason
 * the compactor has none: the structured-output grammar strips `maxLength`, so
 * a bound could only fail the parse and throw the merge — the ceiling is
 * stated in the prompt and enforced in `runEpochMerge`, which refuses a
 * summary that does not actually shrink Block 2.
 */
export function judgmentEpochSummarizer(
  selection: TierSelection,
  ctx: { campaignId: string; turnNumber: number },
): EpochSummarizer {
  return async (span) => {
    const fromTurn = Math.min(...span.map((b) => b.fromTurn));
    const toTurn = Math.max(...span.map((b) => b.toTurn));
    const era = span.map((b) => b.content).join("\n\n");
    // The turn number IS the phase evidence (calls.ts `resolvePhase`): the
    // merge rides G2, so its spend files under the turn that triggered it.
    const result = await callJudgment(selection, {
      name: "epoch_summary",
      schema: EpochSummary,
      campaignId: ctx.campaignId,
      turnNumber: ctx.turnNumber,
      effort: "high",
      maxTokens: STRUCTURED_RICH,
      system: [
        "You are the Chronicler's epoch summarist. What follows is the OLDEST",
        "era of a long campaign, already told as narrated beats. The writer's",
        "compacted memory has outgrown its ceiling, so this era must become ONE",
        "summary that stands in for all of it. Write it SUBTEXT-FIRST: what the",
        "era MEANT — who these people became to each other, the debts and prices",
        "still owed, what is permanently true now that was not before, the",
        "promises made and the ones broken — never a chronology of events.",
        "Past tense, continuous prose, the story's own register.",
        `Keep it under ~1000 words (${EPOCH_TARGET_TOKENS} tokens): the verbatim`,
        "turns survive elsewhere in the archive, so compress without anxiety —",
        "but what you leave out leaves the writer's working memory. Compress",
        "toward consequence.",
      ].join(" "),
      prompt: `Fold turns ${fromTurn}–${toTurn} into one epoch summary:\n\n${era}`,
    });
    return result.summary.trim();
  };
}

async function loadEpochCandidates(db: Db, campaignId: string): Promise<EpochCandidate[]> {
  const rows = await db
    .select()
    .from(compactedBeats)
    .where(and(eq(compactedBeats.campaignId, campaignId), notTombstoned(compactedBeats)))
    .orderBy(asc(compactedBeats.position), asc(compactedBeats.id));
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    content: r.content,
    fromTurn: r.fromTurn,
    toTurn: r.toTurn,
    turnId: r.turnId,
    isEpoch: r.isEpoch,
    provenance: r.provenance,
  }));
}

/**
 * A monotonic count of epoch merges ever run for a campaign — tombstoned rows
 * INCLUDED, because a higher merge folds its constituents away. The soak needs
 * a number that only goes up to see the event: the watermark cannot see it (an
 * epoch inherits its span's existing `toTurn`, so `max(toTurn)` never moves).
 */
export async function epochEventCount(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(compactedBeats)
    .where(and(eq(compactedBeats.campaignId, campaignId), eq(compactedBeats.isEpoch, true)));
  return row?.n ?? 0;
}

export interface EpochMergeResult {
  merged: boolean;
  beatsMerged: number;
  epochLevel: number;
  /** Block 2's total after the merge — the loop's progress measure. */
  b2TokensAfter: number;
}

/**
 * One epoch merge: fold the oldest 50% of live beats into a single summary,
 * tombstone the originals, and insert the summary AT the merged span's
 * position — one transaction, because a tombstone that committed without its
 * summary would evict the era silently, which is the exact v3 failure §6.2
 * exists to end.
 *
 * Takes NO turn id on purpose: the epoch inherits its oldest constituent's,
 * never the merging turn's (see the insert below, §6.7).
 */
export async function runEpochMerge(
  db: Db,
  campaignId: string,
  opts: { summarizer: EpochSummarizer },
): Promise<EpochMergeResult> {
  const beats = await loadEpochCandidates(db, campaignId);
  const b2Before = beats.reduce((s, b) => s + approxTokens(b.content), 0);
  const span = selectEpochSpan(beats);
  if (span.length === 0) {
    // The floor of the recursion: a single row over the whole 8k ceiling has
    // nothing to merge with. Loud — Block 2 stays over budget by design rather
    // than looping on itself.
    console.warn(
      "[compaction] Block-2 over ceiling with fewer than two beats — nothing to merge, ceiling stands",
      { campaignId, beats: beats.length, b2Tokens: b2Before },
    );
    return { merged: false, beatsMerged: 0, epochLevel: 0, b2TokensAfter: b2Before };
  }

  const summary = await opts.summarizer(span);
  const spanTokens = span.reduce((s, b) => s + approxTokens(b.content), 0);
  const summaryTokens = approxTokens(summary);
  if (summary.length === 0 || summaryTokens >= spanTokens) {
    // STRICT PROGRESS OR NOTHING. A summary at least as long as what it
    // replaces buys no ceiling headroom and would let the loop re-merge the
    // same era forever. Refuse, keep the beats, let the next G2 retry.
    console.warn("[compaction] epoch summary did not shrink its span — merge refused, beats kept", {
      campaignId,
      spanTokens,
      summaryTokens,
      beats: span.length,
    });
    return { merged: false, beatsMerged: 0, epochLevel: 0, b2TokensAfter: b2Before };
  }
  if (summaryTokens > EPOCH_TARGET_TOKENS) {
    console.warn(`[compaction] epoch summary over its ${EPOCH_TARGET_TOKENS}-token target — kept`, {
      campaignId,
      summaryTokens,
    });
  }

  const level = Math.max(...span.map(epochLevelOf)) + 1;
  const ids = span.map((b) => b.id);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(compactedBeats)
      .set({ tombstonedAt: now })
      .where(and(eq(compactedBeats.campaignId, campaignId), inArray(compactedBeats.id, ids)));
    await tx.insert(compactedBeats).values({
      campaignId,
      content: summary,
      isEpoch: true,
      fromTurn: Math.min(...span.map((b) => b.fromTurn)),
      toTurn: Math.max(...span.map((b) => b.toTurn)),
      // The merged span is the oldest prefix, so its lowest position keeps the
      // epoch exactly where its era was: Block 2 reads oldest-first either way.
      position: Math.min(...span.map((b) => b.position)),
      // The OLDEST constituent's turn id, never the merging turn's — the
      // CONSERVATIVE stamp: a rewind (turnId > N sweep) keeps the era unless
      // the rewind reaches back before the era began. HONEST LIMIT (stack
      // audit 2026-08-01): a rewind landing MID-era keeps the whole epoch,
      // including narrative from turns the rewind un-happened. Unreachable
      // through the retake horizon today (an era's newest beat is ~half the
      // campaign old; the horizon is 10 turns) — rewindCampaign warns loudly
      // if that ever changes. A true fix needs constituent linkage
      // (merged_into) so a crossing rewind can dissolve the epoch and
      // resurrect its still-valid beats — deferred until deep rewind exists.
      turnId: Math.min(...span.map((b) => b.turnId)),
      provenance: `${EPOCH_PROVENANCE}${level}`,
      confidence: 1,
    });
  });

  return {
    merged: true,
    beatsMerged: span.length,
    epochLevel: level,
    b2TokensAfter: await block2Tokens(db, campaignId),
  };
}

/**
 * The ceiling gate, run on every G2 whether or not a compaction fired (Block 2
 * can sit over budget after a rewind or a short window, and §6.2's ceiling is
 * a property of Block 2, not of the compaction cadence).
 *
 * TERMINATION. Each accepted merge replaces m ≥ 2 live rows with exactly 1, so
 * the live count strictly drops by m−1 ≥ 1, AND the summary is refused unless
 * it is strictly smaller than the span it replaces — so Block 2's token total
 * strictly drops too. From n live beats at most n−1 merges are therefore
 * possible before n = 1, where `runEpochMerge` refuses with a loud warn. Both
 * measures are strictly decreasing over a well-founded (integer, bounded
 * below) domain, so the recursion cannot run forever; the per-event cap only
 * bounds the WORK PER TURN, it is not what makes it terminate.
 *
 * DEPTH grows by at most 1 per merge, and a merge only happens when Block 2
 * refills to 8k — with §6.2's sizing (an epoch per ~50 turns) the first merge
 * is ~100 turns of play in and each further level is several merges beyond the
 * last, so depth is a slow logarithm of campaign length, not a runaway. Level
 * is an integer in a string; nothing bounds it and nothing needs to.
 *
 * A merge failure is failure-isolated: warn, leave Block 2 over the ceiling,
 * let the next G2 retry. A too-large prompt is never worth a failed turn.
 */
export async function enforceBlock2Ceiling(
  db: Db,
  campaignId: string,
  turnId: number,
  selection: TierSelection,
  report: CompactionReport,
): Promise<CompactionReport> {
  let b2 = report.b2TokensAfter;
  if (b2 <= BLOCK2_CEILING_TOKENS) return report;

  console.warn("[compaction] Block-2 over the 8k ceiling — epoch merge firing (§6.2)", {
    campaignId,
    b2TokensAfter: b2,
  });
  let merges = 0;
  let beatsMerged = 0;
  let epochLevel = 0;
  try {
    const summarizer = judgmentEpochSummarizer(selection, { campaignId, turnNumber: turnId });
    while (b2 > BLOCK2_CEILING_TOKENS && merges < EPOCH_MAX_MERGES_PER_EVENT) {
      const result = await runEpochMerge(db, campaignId, { summarizer });
      b2 = result.b2TokensAfter;
      if (!result.merged) break;
      merges += 1;
      beatsMerged += result.beatsMerged;
      epochLevel = Math.max(epochLevel, result.epochLevel);
    }
    if (b2 > BLOCK2_CEILING_TOKENS) {
      console.warn("[compaction] Block-2 STILL over the 8k ceiling — next G2 retries", {
        campaignId,
        b2TokensAfter: b2,
        merges,
      });
    }
  } catch (err) {
    console.warn("[compaction] epoch merge failed — Block 2 stays over ceiling, next G2 retries", {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
    b2 = await block2Tokens(db, campaignId);
  }
  return {
    ...report,
    b2TokensAfter: b2,
    epochMergeDue: b2 > BLOCK2_CEILING_TOKENS,
    epochMerges: merges,
    beatsMerged,
    epochLevel,
  };
}

// ---------------------------------------------------------------------------
// The Compositor's compaction step (§5.8 group 2, step "compaction")
// ---------------------------------------------------------------------------

/**
 * Trigger and keep-tail for the real compactor (§6.2). HYSTERESIS is the
 * point: trigger (20) sits well above keep-tail (12), so each compaction
 * event batches 8 exchanges and the next fires 8 turns later — the window
 * oscillates 12–20, and §5.6's "~10 turns" cadence is met. Equal trigger/keep
 * would trickle-compact one exchange per turn past the threshold, which is
 * a sliding window by another name and self-invalidates the Block-2 prefix
 * every turn (§5.6 forbids exactly that). Tunable; the C10 soak's
 * cache-fraction assertions calibrate.
 *
 * SCALED WITH THE 32k WINDOW (user ruling, 2026-08-05): the exchange numbers
 * are the token ceiling's other half, so 16/10 rose to 20/12. Keep-tail 12 is
 * what makes "12–15 typical turns verbatim" a guarantee rather than an
 * average — the post-compaction tail IS the floor the player's voice memory
 * never drops below, and 10 could not carry the ruled count on its own.
 */
export const COMPACTION_TRIGGER_EXCHANGES = 20;
export const COMPACTION_KEEP_TAIL = 12;
/** The tail never shrinks below this many verbatim exchanges. */
export const COMPACTION_MIN_TAIL = 4;
/**
 * Token-side hysteresis: when the TOKEN ceiling (not the exchange count)
 * triggers, the kept tail shrinks until it weighs ≤ this fraction of the
 * ceiling — so the batch is big enough that the next event is turns away.
 * A fixed keep-tail under a token trigger would trickle-compact one
 * exchange per turn on a token-heavy campaign (§5.6 forbids exactly that).
 *
 * 0.6 → 0.75 with the 32k ruling (2026-08-05). The fraction is what actually
 * decided the live tail length, and at 0.6 the raise would have been half
 * spent: 0.6 × 32k = 19.2k holds only 9 of the player's ~2k-token scenes, so
 * the shrink loop would still have eaten the ruled 10–12. At 0.75 the cap is
 * 24k — the full keep-tail of 12 deep scenes survives, and a heavier scene
 * length shrinks it to 10–12 rather than to the floor. The batch stays a real
 * batch: 32k − 24k = 8k ≈ 4 deep scenes of hysteresis on the token path, 8
 * exchanges on the count path.
 */
export const COMPACTION_TOKEN_KEEP_FRACTION = 0.75;

/**
 * The Chronicler G2 compaction step: run one real (judgment-tier, subtext-
 * first) compaction event when the working window is over the exchange or
 * token threshold; otherwise a cheap no-op. EITHER WAY the §6.2 Block-2
 * ceiling is then enforced — the epoch merge is a property of Block 2's size,
 * not of the compaction cadence, so a campaign whose window is quiet while
 * Block 2 sits over budget still gets merged.
 *
 * The compaction event and the epoch merge are the ONLY sanctioned blocks-2/3
 * cache invalidations (§5.6) — the watermark advances implicitly from the new
 * beats' `toTurn`, so nothing slides without a beat written first, and the
 * merge preserves it (an epoch inherits its span's `toTurn`).
 */
export async function maybeCompact(
  db: Db,
  campaignId: string,
  turnNumber: number,
  selection: TierSelection,
): Promise<CompactionReport> {
  const window = await workingWindow(db, campaignId);
  if (
    !shouldCompact(window, {
      maxExchanges: COMPACTION_TRIGGER_EXCHANGES,
      maxTokens: WINDOW_MAX_TOKENS,
    })
  ) {
    return enforceBlock2Ceiling(
      db,
      campaignId,
      turnNumber,
      selection,
      noChangeReport(await block2Tokens(db, campaignId)),
    );
  }
  // Both triggers get hysteresis: exchange-count keeps the fixed tail; a
  // token trigger additionally shrinks the tail (floor COMPACTION_MIN_TAIL)
  // until the kept exchanges weigh ≤ the keep-fraction of the ceiling.
  const exchangeTokens = (e: ExchangeRow) =>
    approxTokens(e.playerInput) + approxTokens(e.narration);
  let keepTail = Math.min(COMPACTION_KEEP_TAIL, window.length);
  const tailTokens = () =>
    window.slice(Math.max(0, window.length - keepTail)).reduce((s, e) => s + exchangeTokens(e), 0);
  while (
    keepTail > COMPACTION_MIN_TAIL &&
    tailTokens() > WINDOW_MAX_TOKENS * COMPACTION_TOKEN_KEEP_FRACTION
  ) {
    keepTail -= 1;
  }
  const report = await runCompaction(db, campaignId, turnNumber, {
    compactor: judgmentCompactor(selection, { campaignId, turnNumber }),
    keepTail,
    provenance: "chronicler_compaction",
  });
  return enforceBlock2Ceiling(db, campaignId, turnNumber, selection, report);
}
