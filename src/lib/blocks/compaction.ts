import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { compactedBeats, episodicRecords } from "@/lib/db/schema";
import { and, asc, eq, gt, max } from "drizzle-orm";
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

export const WINDOW_MAX_EXCHANGES = 12;
export const WINDOW_MAX_TOKENS = 16_000;
export const BLOCK2_CEILING_TOKENS = 8_000;

/** Beats-writer signature; M1's Compositor supplies the narrated version. */
export type Compactor = (exchanges: ExchangeRow[]) => Promise<string[]>;

/** M0 stub: one clipped beat per exchange. Replaced by narrated subtext-first compaction at M1. */
export const naiveCompactor: Compactor = async (exchanges) =>
  exchanges.map((e) => `(t${e.turnNumber}) ${e.narration.slice(0, 200)}`);

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
    .orderBy(asc(compactedBeats.position));
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
  /** Over the §6.2 ceiling → the M1 epoch merge is due. Surfaced, not silent. */
  epochMergeDue: boolean;
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
  opts: { compactor?: Compactor; keepTail?: number } = {},
): Promise<CompactionReport> {
  const compactor = opts.compactor ?? naiveCompactor;
  const keepTail = opts.keepTail ?? 4;
  const window = await workingWindow(db, campaignId);
  const toCompact = window.slice(0, Math.max(0, window.length - keepTail));
  if (toCompact.length === 0) {
    const beats = await loadBeats(db, campaignId);
    const b2TokensAfter = beats.reduce((s, b) => s + approxTokens(b.content), 0);
    return {
      compacted: false,
      exchangesCompacted: 0,
      beatsWritten: 0,
      b3TokensTruncated: 0,
      b2TokensAfter,
      epochMergeDue: b2TokensAfter > BLOCK2_CEILING_TOKENS,
    };
  }

  const beatTexts = await compactor(toCompact);
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
      provenance: "compaction_event",
      confidence: 1,
    })),
  );

  const b3TokensTruncated = toCompact.reduce(
    (s, e) => s + approxTokens(e.playerInput) + approxTokens(e.narration),
    0,
  );
  const after = await loadBeats(db, campaignId);
  const b2TokensAfter = after.reduce((s, b) => s + approxTokens(b.content), 0);
  return {
    compacted: true,
    exchangesCompacted: toCompact.length,
    beatsWritten: beatTexts.length,
    b3TokensTruncated,
    b2TokensAfter,
    epochMergeDue: b2TokensAfter > BLOCK2_CEILING_TOKENS,
  };
}
