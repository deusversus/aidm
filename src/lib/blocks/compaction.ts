import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { compactedBeats, episodicRecords } from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { and, asc, eq, gt, max } from "drizzle-orm";
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

export const WINDOW_MAX_EXCHANGES = 12;
export const WINDOW_MAX_TOKENS = 16_000;
export const BLOCK2_CEILING_TOKENS = 8_000;

/** Beats-writer signature; M1's Compositor supplies the narrated version. */
export type Compactor = (exchanges: ExchangeRow[]) => Promise<string[]>;

/** M0 stub: one clipped beat per exchange. Superseded by `judgmentCompactor` at M1. */
export const naiveCompactor: Compactor = async (exchanges) =>
  exchanges.map((e) => `(t${e.turnNumber}) ${e.narration.slice(0, 200)}`);

/**
 * The real M1 compactor (§6.2, subtext-first doctrine): ONE judgment-tier
 * call over the stretch of exchanges leaving the working window, narrating
 * what the stretch MEANT — motives, shifts, debts, what changed between the
 * characters — never a play-by-play. 2–4 beats, each ≤120 words. These beats
 * become the compacted history the KA reads (Block 2) in place of the
 * verbatim turns, so the pressure is on meaning, not recital.
 */
const CompactBeats = z.object({
  beats: z.array(z.string().min(1)).min(1).max(4),
});

export function judgmentCompactor(
  selection: TierSelection,
  ctx: { campaignId: string; turnNumber: number },
): Compactor {
  return async (exchanges) => {
    const transcript = exchanges
      .map((e) => `[Turn ${e.turnNumber}]\nPlayer: ${e.playerInput}\n\n${e.narration}`)
      .join("\n\n");
    const result = await callJudgment(selection, {
      name: "compact_beats",
      schema: CompactBeats,
      campaignId: ctx.campaignId,
      turnNumber: ctx.turnNumber,
      effort: "high",
      maxTokens: 4_000,
      system: [
        "You are the Chronicler's compactor. Compress this stretch of play into",
        "2–4 narrated beats, SUBTEXT-FIRST: say what the stretch MEANT — the",
        "motives that surfaced, the way relationships shifted, the debts and",
        "prices incurred, what is now true that was not before — NOT a",
        "play-by-play of who did what. Each beat is at most 120 words, past",
        "tense, in the story's own register. These beats replace the verbatim",
        "turns in the writer's memory: preserve meaning, discard choreography.",
      ].join(" "),
      prompt: `Compact this stretch into 2–4 subtext-first beats:\n\n${transcript}`,
    });
    return result.beats;
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
  opts: { compactor?: Compactor; keepTail?: number; provenance?: string } = {},
): Promise<CompactionReport> {
  const compactor = opts.compactor ?? naiveCompactor;
  const keepTail = opts.keepTail ?? 4;
  const provenance = opts.provenance ?? "compaction_event";
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
      provenance,
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

// ---------------------------------------------------------------------------
// The Compositor's compaction step (§5.8 group 2, step "compaction")
// ---------------------------------------------------------------------------

/**
 * Trigger and keep-tail for the real compactor (§6.2). HYSTERESIS is the
 * point: trigger (16) sits well above keep-tail (10), so each compaction
 * event batches ~6 exchanges and the next fires ~6 turns later — the window
 * oscillates 10–16 around §6.2's ~12-exchange target. Equal trigger/keep
 * would trickle-compact one exchange per turn past the threshold, which is
 * a sliding window by another name and self-invalidates the Block-2 prefix
 * every turn (§5.6 forbids exactly that). Tunable; the C10 soak's
 * cache-fraction assertions calibrate.
 */
export const COMPACTION_TRIGGER_EXCHANGES = 16;
export const COMPACTION_KEEP_TAIL = 10;
/** The tail never shrinks below this many verbatim exchanges. */
export const COMPACTION_MIN_TAIL = 4;
/**
 * Token-side hysteresis: when the TOKEN ceiling (not the exchange count)
 * triggers, the kept tail shrinks until it weighs ≤ this fraction of the
 * ceiling — so the batch is big enough that the next event is turns away.
 * A fixed keep-tail under a token trigger would trickle-compact one
 * exchange per turn on a token-heavy campaign (§5.6 forbids exactly that).
 */
export const COMPACTION_TOKEN_KEEP_FRACTION = 0.6;

/**
 * The Chronicler G2 compaction step: run one real (judgment-tier, subtext-
 * first) compaction event when the working window is over the exchange or
 * token threshold; otherwise a cheap no-op that still reports the Block-2
 * ceiling state. The compaction event is the ONLY sanctioned blocks-2/3
 * cache invalidation (§5.6) — the watermark advances implicitly from the new
 * beats' `toTurn`, so nothing slides without a beat written first.
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
  if (report.epochMergeDue) {
    // Block-2 over its 8k ceiling → the epoch merge (§6.2) is due. Epoch
    // merges land at M3; until then the condition is surfaced, never silent.
    console.warn("[compaction] Block-2 over the 8k ceiling — epoch merge due (M3)", {
      campaignId,
      b2TokensAfter: report.b2TokensAfter,
    });
  }
  return report;
}
