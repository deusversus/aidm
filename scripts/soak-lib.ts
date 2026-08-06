/**
 * Shared soak harness machinery (M1 soak → extracted for the M2 drift soak).
 * Everything here is the battle-tested turn-driving core from scripts/soak.ts
 * runs #1-#3, moved verbatim: the live-turn discipline (a turn is only "past"
 * when its ROW is terminal), the retry-route ordering (executeTurn kicked
 * BEFORE awaitTerminal re-attaches), per-turn metering against the §10.8
 * assertions, and spend attribution with per-tier projections.
 */

import { COMPACTION_KEEP_TAIL, COMPACTION_TRIGGER_EXCHANGES } from "@/lib/blocks/compaction";
import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import * as schema from "@/lib/db/schema";
import { type UsageStats, estimateCostUsd } from "@/lib/llm/pricing";
import { TIER_MENUS, type TierSelection } from "@/lib/llm/tiers";
import type { ModelCallPhase } from "@/lib/observability/meter";
import { MAX_PLAY_VIEW_REWIND } from "@/lib/turn/rewind";
import { type TurnEvent, attachToTurn, executeTurn, submitTurn } from "@/lib/turn/runtime";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  BUDGET_ASSUMPTIONS,
  assertTurnCost,
  turnCostModel,
} from "../evals/suites/budget-assertions";

export const TURN_TIMEOUT_MS = 180_000;
export const CACHE_READ_FLOOR = 0.5;
/** A narration row written as the connection dropped can land after the turn
 *  settles; the metering re-reads once before calling a row LOST (M2 turn 24). */
export const LEDGER_SETTLE_MS = 2_000;
/** Typed so a rename of the meter's member breaks the build, not the report. */
const HARNESS_PHASE: ModelCallPhase = "harness";

export function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

/** Standing directive: no automated run ever calls Fable. */
export function guardNoFable(selection: Record<string, string>): void {
  for (const [tier, model] of Object.entries(selection)) {
    if (model.toLowerCase().includes("fable")) {
      console.error(
        `[soak] FATAL: tier '${tier}' resolves to '${model}' — a Fable model. Automated runs never call Fable (standing directive). Aborting.`,
      );
      process.exit(1);
    }
  }
}

/** The Bebop Opening State Package both soaks seed from (validated by caller). */
export const BEBOP_OSP = {
  director_inputs: {
    opening_situation:
      "A bounty gone quiet on a Ganymede dock at closing time; the mark was last seen loitering near the noodle stands.",
    spark_reading: "Fatalism worn as freedom — walking toward the thing anyway.",
    suggested_first_arc_question:
      "What does the crew owe each other when the money's already gone?",
  },
  animation_inputs: {
    forbidden_opening_moves: [
      "revealing the recurring antagonist",
      "spending the spark in scene one",
    ],
    opening_pov: "the player's bounty hunter, mid-shift, before the trouble finds them",
  },
  constraints: [
    {
      text: "no harm to children on-screen",
      tier: "hard",
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 1,
    },
    {
      text: "keep the early episodes bounty-shaped",
      tier: "soft",
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 0.8,
    },
  ],
  uncertainties: [
    {
      question: "who the recurring antagonist is",
      safe_assumption: "someone inside the bounty system itself",
      degraded_generation_guidance: "keep antagonist references faceless and institutional",
    },
  ],
  briefs: [
    {
      name: "The Trawler",
      kind: "world",
      brief: "A converted fishing trawler serving as the crew's ship.",
      admit_to_catalog: true,
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 0.9,
    },
  ],
  orphan_facts: ["the player hums the show's theme when a job goes right"],
};

// ---------------------------------------------------------------------------
// One turn through the real loop.
// ---------------------------------------------------------------------------

export type Terminal = "done" | "channel" | "error" | "timeout";

interface AttachResult {
  terminal: Terminal;
  ttftMs: number | null;
  totalMs: number;
  prose: string;
}

function awaitTerminal(turnId: string, submitTime: number): Promise<AttachResult> {
  return new Promise<AttachResult>((resolve) => {
    let ttftMs: number | null = null;
    let prose = "";
    let settled = false;
    const handles: { detach?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (terminal: Terminal) => {
      if (settled) return;
      settled = true;
      if (handles.timer) clearTimeout(handles.timer);
      handles.detach?.();
      resolve({ terminal, ttftMs, totalMs: Date.now() - submitTime, prose });
    };
    handles.timer = setTimeout(() => finish("timeout"), TURN_TIMEOUT_MS);
    handles.detach = attachToTurn(turnId, (e: TurnEvent) => {
      if (e.type === "prose") {
        if (ttftMs === null) ttftMs = Date.now() - submitTime;
        prose += e.text;
      } else if (e.type === "done") {
        finish("done");
      } else if (e.type === "channel") {
        finish("channel");
      } else if (e.type === "error") {
        finish("error");
      }
    });
  });
}

/**
 * The DATABASE's clock, read over the same pool the ledger writes through.
 *
 * Everything this harness bounds — attempt boundaries, the `since` filter on
 * model_calls — is compared against `created_at`, which Postgres stamps from
 * its OWN clock (`defaultNow()`). Bounding with the harness's `Date.now()`
 * compares two clocks. Measured on the dev machine against the Railway
 * instance on 2026-08-01: the local clock ran 1.7 SECONDS ahead. A boundary
 * that far in the future files an attempt's opening ledger rows into the
 * PREVIOUS attempt's bucket — which is the false cost breach per-attempt
 * metering exists to end — and a `since` that far ahead drops the turn's first
 * rows entirely, reporting a live row as lost. One round-trip per boundary
 * (two on a retried turn, one otherwise) buys a single clock.
 *
 * Read as epoch MILLISECONDS on purpose. `select now()` comes back over
 * node-postgres as the string "2026-08-02 02:18:26.932005+00" — not ISO-8601,
 * so parsing it means leaning on implementation-defined `Date` parsing.
 * Epoch-milliseconds has no format and no timezone to get wrong.
 */
export async function dbNow(db: Db): Promise<Date> {
  const result = await db.execute<{ ms: string | number }>(
    sql`select extract(epoch from now()) * 1000 as ms`,
  );
  const ms = Number(result.rows[0]?.ms);
  if (Number.isFinite(ms)) return new Date(ms);
  // Never a NaN date: a poisoned boundary would silently mis-bucket everything
  // downstream. Degrade to the local clock and SAY so.
  console.warn("[soak] could not read the database clock — falling back to the local clock");
  return new Date();
}

export interface TurnRun {
  turnId: string;
  turnNumber: number;
  terminal: Terminal;
  ttftMs: number | null;
  /** Wall-clock for the observed attempt; null when the turn was metered from
   *  the durable record and no latency was observed at all (never 0 — a zero
   *  reads as an impossibly fast turn, and the report prints "—" instead). */
  totalMs: number | null;
  prose: string;
  retried: boolean;
  /**
   * When each ATTEMPT at this turn began, IN DATABASE TIME (`dbNow`) — the §5.7
   * retry route re-anchors the same turn row, so a retried turn's ledger rows
   * sum two or three whole narration writes. The M2 soak asserted that SUM
   * against a single-attempt ceiling and read a retry artifact as a cost breach
   * (turns 9 and 12; the retro's "meter per-attempt, assert per-attempt" ledger
   * item). These boundaries are what make the per-attempt assertion possible.
   */
  attemptStarts: Date[];
  /**
   * False when the boundaries cannot separate the attempts that actually ran —
   * a turn rebuilt from the durable record carries ONE boundary (its row's
   * createdAt) while having been retried, so every attempt's rows land in one
   * bucket. Asserting a single-attempt ceiling against that sum is the false
   * breach again; `meterTurn` flags and SKIPS instead.
   */
  attemptBoundsResolved: boolean;
}

/** A turn is only "past" when its ROW is terminal (soak crash #1). A poll
 *  query that dies on a dropped connection (Railway proxy — drift-soak
 *  crashes #2/#3 both died HERE) retries on the next tick instead of
 *  aborting a user-gated run. */
export async function waitForRowTerminal(
  db: Db,
  turnId: string,
  capMs: number,
): Promise<"complete" | "channel" | "failed" | "stuck"> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    try {
      const [row] = await db
        .select({ status: schema.turns.status })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId));
      const s = row?.status ?? "missing";
      if (s === "complete" || s === "channel" || s === "failed") return s;
    } catch (err) {
      console.warn(
        "[soak] poll query failed (transient connection drop) — retrying:",
        err instanceof Error ? err.message : err,
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return "stuck";
}

export async function runOneTurn(db: Db, campaignId: string, input: string): Promise<TurnRun> {
  // Latency is measured on the LOCAL clock (an interval, so skew cancels);
  // attempt boundaries come from the DB's, because that is the clock the ledger
  // rows are stamped by.
  const submitTime = Date.now();
  const attemptStarts: Date[] = [await dbNow(db)];
  const { turnId, turnNumber } = await submitTurn(db, campaignId, input);
  let res = await awaitTerminal(turnId, submitTime);
  let retried = false;

  if (res.terminal === "timeout") {
    console.warn(`[soak] turn ${turnNumber} outlived the listener — waiting on the row`);
    const settled = await waitForRowTerminal(db, turnId, 5 * 60_000);
    if (settled === "complete" || settled === "channel") {
      const [row] = await db
        .select({ narration: schema.turns.narration })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId));
      res = {
        terminal: settled === "channel" ? "channel" : "done",
        ttftMs: res.ttftMs,
        totalMs: Date.now() - submitTime,
        prose: row?.narration ?? res.prose,
      };
    } else if (settled === "failed") {
      res = { ...res, terminal: "error" };
    }
  }

  if (res.terminal === "error") {
    // Retry-route (§5.7). ORDER MATTERS (C10 audit): executeTurn's synchronous
    // prefix resets the event buffer BEFORE the first await — kick it before
    // awaitTerminal attaches, or the attach replays the stale terminal.
    retried = true;
    await db.update(schema.turns).set({ status: "queued" }).where(eq(schema.turns.id, turnId));
    attemptStarts.push(await dbNow(db));
    const retryTime = Date.now();
    void executeTurn(db, turnId).catch((err) =>
      console.error("[soak] retry execution crashed", { turnId, err }),
    );
    res = await awaitTerminal(turnId, retryTime);
    if (res.terminal === "timeout") {
      const settled = await waitForRowTerminal(db, turnId, 5 * 60_000);
      if (settled === "complete") res = { ...res, terminal: "done" };
      else if (settled === "channel") res = { ...res, terminal: "channel" };
      else if (settled === "failed") res = { ...res, terminal: "error" };
    }
  }

  return {
    turnId,
    turnNumber,
    terminal: res.terminal,
    ttftMs: res.ttftMs,
    totalMs: res.totalMs,
    prose: res.prose,
    retried,
    attemptStarts,
    attemptBoundsResolved: true,
  };
}

// ---------------------------------------------------------------------------
// Per-turn metering (§10.8).
// ---------------------------------------------------------------------------

export type CallRow = typeof schema.modelCalls.$inferSelect;

/** One attempt at a turn, metered on its own (§10.8 per-attempt assertion). */
export interface AttemptRecord {
  /** 1-based; attempt 2+ only exists when the §5.7 retry route fired. */
  index: number;
  usd: number;
  calls: number;
}

export interface TurnRecord {
  step: number;
  turnNumber: number;
  label: string;
  tier: string;
  status: string;
  servedModel: string;
  narrationUsd: number;
  turnUsd: number;
  cacheReadFrac: number | null;
  ttftMs: number | null;
  /** Null when nothing observed the turn run (metered from the durable record):
   *  absent, not zero — the report prints "—", the same as an absent TTFT. */
  totalMs: number | null;
  fallbackUsed: boolean;
  retried: boolean;
  narrationUsage: UsageStats | null;
  /** Per-attempt narration spend — what the ceilings are asserted against. */
  attempts: AttemptRecord[];
  /**
   * A COMPLETE story turn with no narration row in the ledger: the spend is
   * under-counted and the §10.8 assertion could not run at all. M2's turn 24
   * lost its row to a connection drop mid-write and the harness read the hole
   * as a $0.0000 turn that passed every ceiling (M1's turn 13, likewise).
   */
  ledgerNarrationMissing: boolean;
  flags: string[];
  failures: string[];
}

export function usageOf(row: CallRow): UsageStats {
  return {
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_input_tokens: row.cacheReadInputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
  };
}

function readable(row: CallRow): number {
  return row.cacheReadInputTokens + row.inputTokens + row.cacheCreationInputTokens;
}

export function asTier(t: string): TurnTier {
  return t === "douga" || t === "sakuga" ? t : "genga";
}

function primaryNarration(rows: CallRow[]): CallRow | null {
  const narr = rows.filter((r) => r.tier === "narration");
  if (narr.length === 0) return null;
  return narr.reduce((best, r) => (readable(r) > readable(best) ? r : best));
}

/** The turn's chronologically FIRST narration call — the only one that can
 *  prove the TURN-TO-TURN prefix read. On a multi-round turn the largest
 *  prompt is the LAST round, whose read is the guaranteed within-turn hit;
 *  gating on it would hide a broken inter-turn prefix (C3 audit). */
function firstNarration(rows: CallRow[]): CallRow | null {
  const narr = rows.filter((r) => r.tier === "narration");
  if (narr.length === 0) return null;
  return narr.reduce((first, r) => (r.createdAt.getTime() < first.createdAt.getTime() ? r : first));
}

/**
 * Split a turn's narration rows into ATTEMPTS at the retry boundaries
 * (M2 harness ledger: "meter per-attempt, assert per-attempt").
 *
 * Within one attempt a turn legitimately makes several narration calls — the
 * KA's research rounds — and those belong to the attempt's cost. What does NOT
 * belong together is attempt 1 and attempt 2 of the same turn: the §5.7 retry
 * re-anchors and re-writes, so their SUM cannot be compared against a
 * single-attempt ceiling without reading the retry as a cost regression (M2
 * turn 9: three attempts summing $1.10 against a $0.53 ceiling; turn 12: two).
 */
export function partitionAttempts(narrRows: CallRow[], attemptStarts: Date[]): CallRow[][] {
  const ordered = narrRows.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const bounds = attemptStarts.map((d) => d.getTime()).sort((a, b) => a - b);
  if (bounds.length <= 1) return [ordered];
  const buckets: CallRow[][] = bounds.map(() => []);
  for (const row of ordered) {
    let idx = 0;
    for (let i = 0; i < bounds.length; i++) {
      const bound = bounds[i];
      if (bound !== undefined && row.createdAt.getTime() >= bound) idx = i;
    }
    buckets[idx]?.push(row);
  }
  // An attempt that produced no ledger row at all (the executor died before
  // the write) drops out — an empty bucket is not an attempt worth asserting.
  return buckets.filter((b) => b.length > 0);
}

export async function meterTurn(
  db: Db,
  campaignId: string,
  run: TurnRun,
  step: number,
  label: string,
  since: Date,
  coldTurns: Set<number>,
): Promise<TurnRecord> {
  const [turnRow] = await db
    .select({ tier: schema.turns.tier, status: schema.turns.status, sidecar: schema.turns.sidecar })
    .from(schema.turns)
    .where(
      and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.turnNumber, run.turnNumber)),
    );

  const readCalls = (): Promise<CallRow[]> =>
    db
      .select()
      .from(schema.modelCalls)
      .where(
        and(
          eq(schema.modelCalls.campaignId, campaignId),
          eq(schema.modelCalls.turnNumber, run.turnNumber),
          gte(schema.modelCalls.createdAt, since),
        ),
      );

  let rows = await readCalls();
  const storyComplete =
    (turnRow?.status ?? "unknown") === "complete" &&
    (turnRow?.tier === "douga" || turnRow?.tier === "genga" || turnRow?.tier === "sakuga");
  // A ledger write racing the turn's own settle can land a beat late; re-read
  // once before declaring the row LOST, so a slow write is never reported as
  // an under-count (and a genuinely lost row still is — M2 turn 24).
  if (storyComplete && rows.every((r) => r.tier !== "narration")) {
    await new Promise((r) => setTimeout(r, LEDGER_SETTLE_MS));
    rows = await readCalls();
  }

  const turnUsd = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const narrRows = rows.filter((r) => r.tier === "narration");
  const narrationUsd = narrRows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const primary = primaryNarration(rows);
  const fallbackUsed = rows.some((r) => r.fallbackUsed);

  const tier = turnRow?.tier ?? "genga";
  const status = turnRow?.status ?? "unknown";
  const servedModel = primary?.model ?? "(none)";
  const first = firstNarration(rows);
  const cacheReadFrac =
    first && readable(first) > 0 ? first.cacheReadInputTokens / readable(first) : null;

  const flags: string[] = [];
  const failures: string[] = [];
  const attemptBuckets = partitionAttempts(narrRows, run.attemptStarts);
  const attempts: AttemptRecord[] = attemptBuckets.map((bucket, i) => ({
    index: i + 1,
    usd: bucket.reduce((sum, r) => sum + Number(r.costUsd), 0),
    calls: bucket.length,
  }));

  // The lost-row hole (M2 turn 24, M1 turn 13): a complete story turn whose
  // narration never reached the ledger metered as $0.0000 and passed every
  // ceiling silently. It is a COVERAGE failure, not a cheap turn.
  const ledgerNarrationMissing = storyComplete && narrRows.length === 0;
  if (ledgerNarrationMissing) {
    failures.push(
      `turn ${run.turnNumber} (${turnRow?.tier ?? "?"}): COMPLETE with no narration row in the ledger — spend under-counted and the §10.8 assertion could not run (ledger row lost mid-write)`,
    );
  }

  if (fallbackUsed) {
    failures.push(
      `turn ${run.turnNumber}: fallbackUsed=true on a DEV tier (Fable path must be dead)`,
    );
  }
  if (run.retried) flags.push("retried once after a retryable error");
  if (run.terminal === "timeout")
    failures.push(`turn ${run.turnNumber}: hit the ${TURN_TIMEOUT_MS}ms timeout`);

  if (primary && storyComplete) {
    const turnTier = asTier(tier);
    const ceiling = turnCostModel(turnTier, servedModel).coldUsd;
    if (!run.attemptBoundsResolved) {
      // The boundaries cannot tell attempt 1 from attempt 2, so every
      // per-attempt assertion below would be asserting a SUM against a
      // single-attempt model — the M2 false breach, rebuilt. Say so and skip,
      // rather than emit a ceiling failure the evidence cannot support. The
      // spend is still reported; it is the ASSERTION that is unavailable.
      flags.push(
        `retry attempts unresolvable — per-attempt assertion skipped (metered from the durable record: one boundary, ≥2 attempts' ledger rows; narration total $${narrationUsd.toFixed(4)} vs a $${ceiling.toFixed(4)} single-attempt ceiling is not comparable)`,
      );
    } else {
      // PER-ATTEMPT (the M2 harness ledger item). The turn's total still gets
      // reported as spend — it is what the run actually bought — but the cost
      // MODEL describes one attempt, so it is asserted against one attempt.
      for (const attempt of attempts) {
        const where =
          attempts.length > 1 ? `attempt ${attempt.index}/${attempts.length}` : "narration";
        if (attempt.usd > ceiling) {
          failures.push(
            `turn ${run.turnNumber} (${tier}/${servedModel}): ${where} $${attempt.usd.toFixed(4)} > cold ceiling $${ceiling.toFixed(4)}`,
          );
        }
        const absolute = assertTurnCost(turnTier, attempt.usd);
        if (absolute) failures.push(`turn ${run.turnNumber} (${where}): ${absolute}`);
      }
      if (attempts.length > 1) {
        flags.push(
          `turn total $${narrationUsd.toFixed(4)} sums ${attempts.length} attempts (retry inflation) — ceilings asserted per attempt`,
        );
      }

      // Research rounds are the calls after the FIRST one WITHIN an attempt. A
      // retry's opening call is not a follow-up read — it re-anchors the turn,
      // and holding it to the within-turn floor charged the retry twice. With
      // unresolved boundaries every retry's opening call looks like a research
      // round, so this rides the same gate.
      for (const bucket of attemptBuckets) {
        for (const call of bucket.slice(1)) {
          const frac = readable(call) > 0 ? call.cacheReadInputTokens / readable(call) : null;
          if (frac !== null && frac < CACHE_READ_FLOOR) {
            failures.push(
              `turn ${run.turnNumber} (${tier}): WITHIN-turn research read frac ${frac.toFixed(2)} < ${CACHE_READ_FLOOR} floor (§5.6 guaranteed read missed)`,
            );
          }
        }
      }
    }
    if (cacheReadFrac !== null) {
      if (coldTurns.has(run.turnNumber)) {
        flags.push(
          `cold turn — turn-to-turn cache-read frac ${cacheReadFrac.toFixed(2)} (prefix creation expected)`,
        );
      } else if (cacheReadFrac === 0) {
        // M2R5 C3 retired the "B3 re-creates by design" excuse: the window now
        // renders one block per exchange with a MOVING tail breakpoint, so on
        // a warm turn every block but the newest exchange is byte-identical to
        // what the prior turn wrote. A zero-read first narration call is a
        // broken prefix, not the architecture doing its job.
        failures.push(
          `turn ${run.turnNumber} (${tier}): first narration call read ZERO cached tokens on a warm turn (§5.6 moving tail should have read the prior window)`,
        );
      } else if (cacheReadFrac < BUDGET_ASSUMPTIONS.assumedCacheHitRate) {
        flags.push(
          `turn-to-turn cache-read frac ${cacheReadFrac.toFixed(2)} under the ${BUDGET_ASSUMPTIONS.assumedCacheHitRate} assumption (pnpm cache:gauge is the running measure)`,
        );
      }
    }
  }

  const contract = TURN_CONTRACTS[asTier(tier)];
  if (run.ttftMs !== null && run.ttftMs > contract.ttftTargetMs) {
    flags.push(`TTFT ${run.ttftMs}ms > target ${contract.ttftTargetMs}ms`);
  }
  if (run.totalMs !== null && run.totalMs > contract.totalTargetMs) {
    flags.push(`total ${run.totalMs}ms > target ${contract.totalTargetMs}ms`);
  }

  return {
    step,
    turnNumber: run.turnNumber,
    label,
    tier,
    status,
    servedModel,
    narrationUsd,
    turnUsd,
    cacheReadFrac,
    ttftMs: run.ttftMs,
    totalMs: run.totalMs,
    fallbackUsed,
    retried: run.retried,
    narrationUsage: primary ? usageOf(primary) : null,
    attempts,
    ledgerNarrationMissing,
    flags,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Coverage: every settled turn metered, every played turn inside a sitting.
// Both holes are M2 drift-soak ledger items (docs/retros/M2-drift-soak.md).
// ---------------------------------------------------------------------------

/**
 * Meter a turn the driving loop never saw settle (M2's turn 9): crash debris
 * re-anchored through the stale-turn retry route consumed its scripted beat
 * and left NO record — so it was never asserted at all, and the run reported
 * full metering coverage it did not have. The record is rebuilt from the
 * durable row; latency is honestly absent rather than invented.
 */
export async function meterSettledTurn(
  db: Db,
  campaignId: string,
  turnNumber: number,
  step: number,
  label: string,
  coldTurns: Set<number>,
  /** True when the harness itself drove the §5.7 retry route on this turn
   *  (drift-soak's stale route does; a turn that settled on another
   *  executor's watch did not, and must not wear the flag). */
  retried = false,
): Promise<TurnRecord | null> {
  const [row] = await db
    .select({
      id: schema.turns.id,
      status: schema.turns.status,
      createdAt: schema.turns.createdAt,
    })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.turnNumber, turnNumber)));
  if (!row) return null;
  const terminal: Terminal =
    row.status === "channel" ? "channel" : row.status === "complete" ? "done" : "error";
  const run: TurnRun = {
    turnId: row.id,
    turnNumber,
    terminal,
    ttftMs: null,
    // Wall-clock across a crash would measure the OUTAGE, not the turn — and 0
    // would read as an impossibly fast turn that passed the latency contract.
    // Absent is the truth; the report prints "—", like an absent TTFT.
    totalMs: null,
    prose: "",
    retried,
    // The row's createdAt is a DATABASE stamp, the same clock the ledger rows
    // carry — but it is ONE boundary. When this turn was retried, its attempts
    // cannot be separated from it, and meterTurn skips the per-attempt
    // assertion rather than asserting their sum.
    attemptStarts: [row.createdAt],
    attemptBoundsResolved: !retried,
  };
  const record = await meterTurn(db, campaignId, run, step, label, row.createdAt, coldTurns);
  record.flags.push(
    `re-anchored: metered from the durable record (the driving loop never saw it settle; latency unobserved${retried ? ", attempt boundaries unresolvable" : ""})`,
  );
  return record;
}

export interface MeteringCoverage {
  /** Turns in range with no TurnRecord at all — never asserted. */
  missing: number[];
  /** Metered turns whose narration row was lost — asserted against nothing. */
  unasserted: number[];
  certified: boolean;
  lines: string[];
}

/**
 * The run-end coverage assertion. M2 reported "every turn metered in-invocation
 * passed" while three of twenty-four were never asserted — the harness had no
 * way to say so, because absence of a record looked exactly like absence of a
 * problem. It says so now.
 */
export function meteringCoverage(
  records: TurnRecord[],
  reachedTurn: number,
  fromTurn = 1,
): MeteringCoverage {
  const seen = new Set(records.map((r) => r.turnNumber));
  const missing: number[] = [];
  for (let n = fromTurn; n <= reachedTurn; n++) if (!seen.has(n)) missing.push(n);
  const unasserted = records.filter((r) => r.ledgerNarrationMissing).map((r) => r.turnNumber);
  const certified = missing.length === 0 && unasserted.length === 0;
  const lines = [
    `turns ${fromTurn}..${reachedTurn}: ${reachedTurn - fromTurn + 1 - missing.length} metered, ${missing.length} unmetered`,
    missing.length > 0 ? `UNMETERED (never asserted): ${missing.join(", ")}` : "",
    unasserted.length > 0
      ? `METERED BUT UNASSERTED (narration ledger row lost): ${unasserted.join(", ")}`
      : "",
    certified
      ? "metering coverage CERTIFIED — every played turn carries an assertion"
      : "metering coverage NOT certified — the cost verdict covers less than the run",
  ].filter((l) => l.length > 0);
  return { missing, unasserted, certified, lines };
}

export interface SittingWindow {
  sessionNumber: number;
  openedAt: Date;
  closedAt: Date | null;
  closeTrigger: string | null;
}

export interface SessionCoverage {
  sittings: SittingWindow[];
  /** The open sitting's number, or null when play has no sitting at all. */
  openNow: number | null;
  /** Completed turns that fell outside every sitting window. */
  turnsOutside: number[];
  certified: boolean;
  lines: string[];
}

/** The open sitting (§9.4), or null — a pure read, so the harness can GUARD
 *  before a turn instead of discovering the hole in the retro. */
export async function openSittingNumber(db: Db, campaignId: string): Promise<number | null> {
  const [row] = await db
    .select({ n: schema.sessionRecords.sessionNumber })
    .from(schema.sessionRecords)
    .where(
      and(
        eq(schema.sessionRecords.campaignId, campaignId),
        notTombstoned(schema.sessionRecords),
        isNull(schema.sessionRecords.closedAt),
      ),
    )
    .orderBy(schema.sessionRecords.sessionNumber);
  return row?.n ?? null;
}

/**
 * Session-lifecycle coverage (M2's fourth hole). The M2 run's only close was a
 * crash-abort's, mid-turn-9; turns 10–24 then played with NO open sitting and
 * the run's session-lifecycle coverage was, in the retro's words, "weaker than
 * designed and NOT certified" — discovered afterwards, by hand. This measures
 * it from the record, and the report states it either way.
 */
export async function sessionCoverage(db: Db, campaignId: string): Promise<SessionCoverage> {
  const sittings = await db
    .select({
      sessionNumber: schema.sessionRecords.sessionNumber,
      openedAt: schema.sessionRecords.openedAt,
      closedAt: schema.sessionRecords.closedAt,
      closeTrigger: schema.sessionRecords.closeTrigger,
    })
    .from(schema.sessionRecords)
    .where(
      and(eq(schema.sessionRecords.campaignId, campaignId), notTombstoned(schema.sessionRecords)),
    )
    .orderBy(schema.sessionRecords.sessionNumber);

  const turnRows = await db
    .select({ turnNumber: schema.turns.turnNumber, completedAt: schema.turns.completedAt })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "complete")));

  const now = Date.now();
  const turnsOutside: number[] = [];
  for (const t of turnRows) {
    const at = t.completedAt?.getTime();
    if (at === undefined) continue;
    const inside = sittings.some(
      (s) => at >= s.openedAt.getTime() && at <= (s.closedAt?.getTime() ?? now),
    );
    if (!inside) turnsOutside.push(t.turnNumber);
  }
  turnsOutside.sort((a, b) => a - b);

  const openNow = sittings.find((s) => s.closedAt === null)?.sessionNumber ?? null;
  const certified = sittings.length > 0 && turnsOutside.length === 0;
  const lines = [
    `${sittings.length} sitting(s); ${sittings.filter((s) => s.closedAt).length} closed (${
      sittings
        .filter((s) => s.closedAt)
        .map((s) => `#${s.sessionNumber}:${s.closeTrigger ?? "?"}`)
        .join(", ") || "none"
    }); open now: ${openNow === null ? "NONE" : `#${openNow}`}`,
    turnsOutside.length > 0
      ? `turns played OUTSIDE any sitting: ${turnsOutside.join(", ")} — session-lifecycle coverage NOT certified by this run`
      : "every completed turn played inside a sitting — session-lifecycle coverage CERTIFIED",
  ];
  return { sittings, openNow, turnsOutside, certified, lines };
}

// ---------------------------------------------------------------------------
// The run plan + its price (the M3 gate runs 100 turns; §10.3 asks 50–100).
// ---------------------------------------------------------------------------

export interface SoakPlan {
  /** The STORY-turn target: turns the pen wrote a scene for (`status='complete'`).
   *  Channel turns are NOT part of it — see `planWindow`. */
  turns: number;
  /** Ops keyed to turn numbers. Specials keep their scripted turns; the
   *  structural ops scale with the run so a 100-turn plan is not a 30-turn
   *  plan with seventy filler beats bolted on the end. */
  pinAfter: number;
  midpointAfter: number;
  rewindAfter: number;
  rewindDepth: number;
  /** Channel beats (booth/override) the beat plan schedules inside the window:
   *  each consumes a turn NUMBER and produces no scene. */
  channelBeats: number;
  /** Turn submissions the plan implies — story target + scheduled channel beats. */
  plannedSteps: number;
  maxSteps: number;
}

/** Pure: the same N always yields the same plan (the dry-run prints it). */
export function buildSoakPlan(
  turns: number,
  pinAfter: number,
  rewindDepth: number,
  channelBeats = 0,
): SoakPlan {
  if (!Number.isInteger(turns) || turns < 1) {
    throw new Error(`[soak] --turns must be a positive integer (got ${turns})`);
  }
  if (rewindDepth > MAX_PLAY_VIEW_REWIND) {
    // §6.7: the play view's retake horizon. A soak that rewinds deeper than a
    // player can would be exercising the studio-view path while claiming to
    // exercise play.
    throw new Error(
      `[soak] rewind depth ${rewindDepth} exceeds the ${MAX_PLAY_VIEW_REWIND}-turn retake horizon (§6.7)`,
    );
  }
  const midpointAfter = Math.floor(turns / 2);
  // Two thirds in — 20/30 at the default, the M1 plan's own position — and far
  // enough past the midpoint that the REWIND ITSELF clears it: the op un-happens
  // `rewindDepth` turns, so `rewindAfter > midpointAfter` is not enough. At
  // N=10 that older guard put the rewind after turn 6 with depth 2, landing the
  // re-climb at turn 4 — before the midpoint close at 5 that the run had
  // already crossed, re-playing turns across a session boundary. The landing
  // turn is what must clear it.
  const rewindAfter = Math.max(midpointAfter + rewindDepth, Math.floor((turns * 2) / 3));
  return {
    turns,
    pinAfter,
    midpointAfter,
    rewindAfter,
    rewindDepth,
    channelBeats,
    plannedSteps: turns + channelBeats,
    // Every submission the run can make: the story target, the channel beats
    // that consume a turn number without producing one, the rewind's re-climb,
    // and headroom for an unscripted turn the classifier routes to a channel.
    maxSteps: turns + channelBeats + rewindDepth + 6,
  };
}

/**
 * Walk the turn NUMBERS a run will consume to reach `storyToPlay` story turns.
 *
 * A channel beat (a booth exchange, an `/override`) takes a turn number and
 * writes no scene, so `--turns=50` over a plan with two channel beats is 52
 * submissions and 50 completed story turns. The N=50 gate run (2026-08-05)
 * played 50 NUMBERED turns instead and banked 48 — one short of §10.3's floor,
 * which made flywheel-prospective skip the very run it exists to grade. The
 * loop targets what this counts.
 */
export function planWindow(
  startTurn: number,
  storyToPlay: number,
  isChannelBeat: (turn: number) => boolean,
): { steps: number; storySteps: number; channelSteps: number; windowEnd: number } {
  let turn = startTurn;
  let storySteps = 0;
  let channelSteps = 0;
  // A predicate that answered true forever would never finish the walk; the
  // scripted plan cannot do that, but a bad predicate must not hang a run.
  const ceiling = startTurn + storyToPlay * 2 + 64;
  while (storySteps < storyToPlay && turn < ceiling) {
    turn += 1;
    if (isChannelBeat(turn)) channelSteps += 1;
    else storySteps += 1;
  }
  return { steps: storySteps + channelSteps, storySteps, channelSteps, windowEnd: turn };
}

export interface ResumePlan {
  existingStory: number;
  storyTarget: number;
  /** Story turns this invocation owes the target — never negative. */
  toPlay: number;
  startTurn: number;
  window: ReturnType<typeof planWindow>;
}

/**
 * What a `--campaign=` resume owes: the story turns the target is short of, and
 * the turn-number window they span. A campaign already at or past the target
 * plays nothing (`toPlay: 0`) rather than topping up to a rounder number.
 */
export function resumePlan(
  existingStory: number,
  storyTarget: number,
  startTurn: number,
  isChannelBeat: (turn: number) => boolean,
): ResumePlan {
  const toPlay = Math.max(0, storyTarget - existingStory);
  return {
    existingStory,
    storyTarget,
    toPlay,
    startTurn,
    window: planWindow(startTurn, toPlay, isChannelBeat),
  };
}

/**
 * Completed STORY turns banked for a campaign — the exact quantity the §10.3
 * gate reads (`evals/suites/flywheel-prospective.ts` counts `status='complete'`
 * turn rows). Channel turns carry `status='channel'` and never count. Read from
 * the database rather than tallied in memory so a rewind's deleted spine rows
 * (§6.7) subtract themselves and a resumed invocation starts from the truth.
 */
export async function countStoryTurns(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "complete")));
  return row?.n ?? 0;
}

/** The highest turn number the campaign has issued — where a resume continues. */
export async function maxTurnNumber(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(max(${schema.turns.turnNumber}), 0)::int` })
    .from(schema.turns)
    .where(eq(schema.turns.campaignId, campaignId));
  return row?.n ?? 0;
}

/** The shape `--campaign=` accepts: enough of the row to prove it is a soak. */
export interface SoakCampaignRow {
  id: string;
  title: string | null;
  status: string;
  openingPackage: unknown;
}

/**
 * `--campaign=<uuid>` writes LIVE turns into an existing campaign. The dev
 * database also holds the player's own campaigns, so the resume path refuses
 * anything that is not demonstrably a soak: a soak-shaped title (the same
 * `%soak%` match the gate's auto-discovery uses), an active status, and an
 * Opening State Package to have been seeded from. Pure — the caller reads the
 * row and does the exiting.
 */
export function assertSoakCampaign(
  row: SoakCampaignRow | undefined,
  campaignId: string,
): { ok: true; row: SoakCampaignRow } | { ok: false; reason: string } {
  if (!row) {
    return { ok: false, reason: `campaign ${campaignId} does not exist in this database` };
  }
  if (!row.title || !/soak/i.test(row.title)) {
    return {
      ok: false,
      reason: `campaign ${campaignId} is titled '${row.title ?? "(untitled)"}' — not a soak campaign (the title must match /soak/i, the same match the §10.3 gate discovers by). REFUSING to play live turns into a campaign that may be the player's.`,
    };
  }
  if (row.status !== "active") {
    return {
      ok: false,
      reason: `campaign ${campaignId} is '${row.status}', not active — a closed or archived run is not resumable`,
    };
  }
  if (!row.openingPackage || typeof row.openingPackage !== "object") {
    return {
      ok: false,
      reason: `campaign ${campaignId} carries no Opening State Package — it was never seeded as a soak run`,
    };
  }
  return { ok: true, row };
}

/**
 * Ops this N cannot fire — a short run genuinely drops them, and the plan says
 * so out loud rather than letting the event-mix checklist report the absence as
 * a coverage miss the reader has to diagnose.
 */
export function droppedOps(plan: SoakPlan): string[] {
  const dropped: string[] = [];
  if (plan.pinAfter < 1 || plan.pinAfter > plan.turns) {
    dropped.push(
      `pin (scheduled after turn ${plan.pinAfter}, which N=${plan.turns} never reaches)`,
    );
  }
  if (plan.midpointAfter < 1) {
    dropped.push(`session close/reopen (N=${plan.turns} has no midpoint turn to fire after)`);
  }
  if (plan.rewindAfter > plan.turns) {
    dropped.push(
      `rewind of ${plan.rewindDepth} (scheduled after turn ${plan.rewindAfter}, which N=${plan.turns} never reaches)`,
    );
  }
  return dropped;
}

/**
 * Measured tier mix — RE-BASELINED on the N=50 flat-high soak (2026-08-05),
 * the first run to postdate BOTH the §3 flatten and C9's douga calibration.
 * 14 douga / 22 genga / 12 sakuga across the 48 STORY turns the campaign
 * banked (the two turns the rewind un-happened are counted as the douga they
 * were re-climbed as, not the sakuga they were tombstoned from — the mix has
 * to describe what survives, since that is what the campaign was priced for).
 *
 * The douga share went 4% → 29%, and that is the calibration landing, not
 * noise: C9 (2026-07-18) found douga STRUCTURALLY unreachable — the intent
 * probe's emitted floor was 0.2 against a <0.2 threshold, so zero douga turns
 * existed in a 39-turn corpus — and moved the threshold to <0.3 while teaching
 * the probe anchors toward 0.1-0.2. The prior pool (M1's 30 turns, M2's 24)
 * measured the tier as it was before that fix could bite. Genga stayed the
 * plurality; sakuga fell 28% → 25%.
 *
 * PRICING only, and n=1 — a second run either confirms this or replaces it.
 */
export const MEASURED_TIER_MIX: Record<TurnTier, number> = {
  douga: 0.29,
  genga: 0.46,
  sakuga: 0.25,
};

/** Judgment + probe + G2 spend per turn: the M2 record's mean of (turn $ −
 *  narration $) over its 24 metered turns at DEV tiers ($0.0492). */
export const MEASURED_NON_NARRATION_USD = 0.049;

/**
 * What one CHANNEL step costs: a booth exchange or an `/override` routes to a
 * responder, not to the pen, and the N=50 run's two channel turns measured
 * $0.0022 (override, turn 13) and $0.0240 (booth, turn 15) — mean $0.0131.
 * Pricing them as story turns would inflate the banner by an order of
 * magnitude; leaving them out would under-state a run that submits them.
 */
export const MEASURED_CHANNEL_STEP_USD = 0.013;

/** Session-open/close composers: recap, yokoku, director memo, voice journal. */
const SESSION_COMPOSER_CALLS = 4;

/**
 * Turns whose prefix is legitimately cold: each sitting's first turn, plus
 * every compaction event (§6.2's sanctioned blocks-2/3 invalidation).
 *
 * The cadence, from `shouldCompact` + `maybeCompact` rather than from the
 * constants' difference: the event fires when the window is STRICTLY over the
 * trigger (`length > 20`, so first at 21 exchanges) and keeps a tail of 12, so
 * each event moves the watermark forward by 21 − 12 = 9 and the next event is
 * 9 turns later. First reset at turn 21, then 30, 39 … — at N=100 that is 9
 * resets. (Was 16/10 → 12 resets, before the 32k window ruling of 2026-08-05
 * scaled the exchange numbers with it.)
 *
 * The TOKEN trigger (WINDOW_MAX_TOKENS) stays deliberately unmodeled: it
 * depends on measured prose length, which this estimator does not have. It can
 * only fire an event EARLIER, so the count here is a FLOOR on compaction
 * resets — and the all-cold ceiling `estimateRunPrice` prints is what bounds
 * the run either way.
 */
export function coldOpensFor(
  turns: number,
  sessions: number,
): { total: number; compactions: number } {
  const firstAt = COMPACTION_TRIGGER_EXCHANGES + 1;
  const step = Math.max(1, firstAt - COMPACTION_KEEP_TAIL);
  const compactions = turns >= firstAt ? Math.floor((turns - firstAt) / step) + 1 : 0;
  return { total: sessions + compactions, compactions };
}

export interface RunPriceEstimate {
  /** STORY turns priced — what the run is targeting. */
  turns: number;
  /** Channel beats scheduled inside the window (booth/override responders). */
  channelSteps: number;
  /** Submissions implied: story turns + channel steps. */
  steps: number;
  channelUsd: number;
  narrationModel: string;
  coldTurns: number;
  warmTurns: number;
  warmFloorUsd: number;
  expectedUsd: number;
  coldCeilingUsd: number;
  sessionOverheadUsd: number;
  lines: string[];
}

/**
 * What N turns cost at DEV tiers, from the §10.8 cost model — printed BEFORE
 * anything runs, because the standing rule is that the user prices a run and
 * then authorizes it, never the other way round.
 *
 * The model is deliberately conservative: `turnCostModel` carries p95 thinking
 * allowances, so this reads as an upper-leaning number, not a forecast.
 */
export function estimateRunPrice(
  turns: number,
  selection: TierSelection,
  sessions: number,
  channelSteps = 0,
): RunPriceEstimate {
  const model = selection.narration;
  let warmPerTurn = MEASURED_NON_NARRATION_USD;
  let coldPerTurn = MEASURED_NON_NARRATION_USD;
  const mixLines: string[] = [];
  for (const tier of ["douga", "genga", "sakuga"] as const) {
    const share = MEASURED_TIER_MIX[tier];
    const m = turnCostModel(tier, model);
    warmPerTurn += m.warmUsd * share;
    coldPerTurn += m.coldUsd * share;
    mixLines.push(
      `${tier} ${(share * 100).toFixed(0)}% (warm ${fmtUsd(m.warmUsd)} / cold ${fmtUsd(m.coldUsd)})`,
    );
  }
  const cold = coldOpensFor(turns, sessions);
  const coldTurns = Math.min(turns, cold.total);
  const warmTurns = turns - coldTurns;

  const prefix = Math.max(
    0,
    TURN_CONTRACTS.genga.promptBudgetTokens - BUDGET_ASSUMPTIONS.dynamicTokensPerTurn,
  );
  // Post-M3-C1 the session composers carry the tool law's constant array, so
  // they READ the KA's prefix instead of writing a second one (plan C1 item 4).
  const perComposer = estimateCostUsd(model, {
    input_tokens: 1_000,
    output_tokens: 400,
    cache_read_input_tokens: prefix,
  });
  const sessionOverheadUsd = perComposer * SESSION_COMPOSER_CALLS * sessions;
  // Channel steps are submissions the run makes and pays for, at responder
  // prices rather than pen prices. Their effect on the COMPACTION cadence is
  // deliberately unmodeled (they write no exchange the window carries), which
  // leaves the cold-turn count keyed to story turns as before.
  const channelUsd = channelSteps * MEASURED_CHANNEL_STEP_USD;

  const warmFloorUsd = turns * warmPerTurn + sessionOverheadUsd + channelUsd;
  const expectedUsd =
    warmTurns * warmPerTurn + coldTurns * coldPerTurn + sessionOverheadUsd + channelUsd;
  const coldCeilingUsd = turns * coldPerTurn + sessionOverheadUsd + channelUsd;

  const lines = [
    `=== PRICE ESTIMATE — ${turns} STORY turn(s) + ${channelSteps} scheduled channel step(s) = ${turns + channelSteps} submission(s), at DEV tiers ===`,
    `narration ${model} · judgment ${selection.judgment} · probe ${selection.probe}`,
    `tier mix (measured, 48 story turns — N=50 flat-high soak 2026-08-05): ${mixLines.join(" · ")}`,
    `non-narration per turn (measured, M2): ${fmtUsd(MEASURED_NON_NARRATION_USD)}`,
    `channel steps (booth/override — consume a turn number, write no scene): ${channelSteps} × ${fmtUsd(MEASURED_CHANNEL_STEP_USD)} = ${fmtUsd(channelUsd)}`,
    `cache: ${warmTurns} warm turn(s) · ${coldTurns} cold (${sessions} sitting open(s) + ${cold.compactions} compaction reset(s))`,
    `  all-warm floor      ${fmtUsd(warmFloorUsd)}`,
    `  EXPECTED            ${fmtUsd(expectedUsd)}`,
    `  all-cold ceiling    ${fmtUsd(coldCeilingUsd)}`,
    `  (of which session composers: ${fmtUsd(sessionOverheadUsd)} over ${sessions} sitting(s))`,
    "the model carries §10.8's p95 thinking allowances AND every research round-trip",
    "the tier contracts — a deliberate OVER-model (budget-assertions.ts). The N=50",
    "run (2026-08-05) measured $0.180/turn all-in at DEV tiers, well under its own",
    "EXPECTED. Treat floor..EXPECTED as the band, and expect to land beneath it.",
    "",
    "SPEND IS GATED BY THE USER: this run is not authorized until the user approves",
    "this number. `--dry-run` is the only unattended execution (zero model calls).",
  ];
  return {
    turns,
    channelSteps,
    steps: turns + channelSteps,
    channelUsd,
    narrationModel: model,
    coldTurns,
    warmTurns,
    warmFloorUsd,
    expectedUsd,
    coldCeilingUsd,
    sessionOverheadUsd,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Drift verdict classification (§4.5 M2R3 — the third class).
// ---------------------------------------------------------------------------

/** One blind reading of an axis at a sample, as the soak snapshots it. */
export interface DriftPoint {
  atTurn: number;
  delta: number;
  confidence: number;
  consecutiveDrift: number;
}

/** The engine's triple gate (imported values passed in, never re-hardcoded). */
export interface DriftGate {
  threshold: number;
  confidence: number;
  consecutive: number;
}

/**
 * How an axis's drift sequence resolves at run end (§4.5 gate parity):
 *  - clean         never drifted
 *  - corrected     drifted out, then pulled back in band (the machinery WORKING)
 *  - unresolved    final read drifting but below the consecutive trigger (never due)
 *  - player_driven gate tripped, the attribution charged the PLAYER, the retake
 *                  closed — ESCALATED to steering honesty, NOT a fail (M2R3)
 *  - uncorrected   gate tripped and STILL engaged at run end — the FAIL
 *
 * The `player_driven` class is what the M2 drift soak lacked: continuity ended
 * the run engaged (delta 5.2, 13 consecutive) but the PLAYER drove it, and the
 * harness had no box for "the player did it" — so it read FAIL. With the drift
 * band's gate-trip attribution, such an axis is escalated, not failed.
 */
export type AxisVerdictClass =
  | "clean"
  | "corrected"
  | "unresolved"
  | "player_driven"
  | "uncorrected";

export function classifyAxisVerdict(
  seq: DriftPoint[],
  gate: DriftGate,
  playerDriven: boolean,
): AxisVerdictClass {
  const drifting = (x: DriftPoint) => x.delta >= gate.threshold && x.confidence >= gate.confidence;
  const engaged = (x: DriftPoint) => drifting(x) && x.consecutiveDrift >= gate.consecutive;
  const ordered = seq.slice().sort((a, b) => a.atTurn - b.atTurn);
  const last = ordered[ordered.length - 1];
  if (!last || !ordered.some(drifting)) return "clean";
  if (engaged(last)) return playerDriven ? "player_driven" : "uncorrected";
  if (drifting(last)) return "unresolved";
  return "corrected";
}

// ---------------------------------------------------------------------------
// Spend attribution.
// ---------------------------------------------------------------------------

export interface SpendAttribution {
  totalUsd: number;
  attributedUsd: number;
  overheadUsd: number;
  /**
   * What the HARNESS spent measuring, not what the engine spent playing
   * (`phase='harness'`): the synthetic player's probes, the exit gauge's
   * classifier. Its own bucket because neither of the other two is honest —
   * a gauge row carries the turn number it MEASURED, so it would ride
   * `attributedUsd` and inflate every per-turn baseline read out of it, while
   * calling it session overhead would bill the run for work no player causes.
   */
  harnessUsd: number;
  turnsPerSession: number;
  avgNonNarrationUsd: number;
  avgCacheReadFrac: number | null;
  projections: { model: string; perTurnUsd: number; perSessionUsd: number }[];
}

export async function attributeSpend(
  db: Db,
  campaignId: string,
  records: TurnRecord[],
  sessions: number,
): Promise<SpendAttribution> {
  // One read, three buckets. The phase is asked FIRST: a harness row's turn
  // number is the turn it measured, not the turn that paid for it. A NULL phase
  // (every row written before M3 C1, including the N=50 run's persona probes)
  // keeps the pure turn-number split it has always had — turn-less, so overhead.
  const all = await db
    .select({
      costUsd: schema.modelCalls.costUsd,
      turnNumber: schema.modelCalls.turnNumber,
      phase: schema.modelCalls.phase,
    })
    .from(schema.modelCalls)
    .where(eq(schema.modelCalls.campaignId, campaignId));

  let totalUsd = 0;
  let attributedUsd = 0;
  let harnessUsd = 0;
  for (const r of all) {
    const usd = Number(r.costUsd);
    totalUsd += usd;
    if (r.phase === HARNESS_PHASE) harnessUsd += usd;
    else if (r.turnNumber !== null && r.turnNumber >= 1) attributedUsd += usd;
  }

  const story = records.filter((r) => r.narrationUsage !== null && r.status === "complete");
  const turnsPerSession = Math.max(1, Math.round(story.length / sessions));

  const avgNonNarrationUsd =
    story.length > 0
      ? story.reduce((sum, r) => sum + (r.turnUsd - r.narrationUsd), 0) / story.length
      : 0;

  const warmFracs = records.map((r) => r.cacheReadFrac).filter((f): f is number => f !== null);
  const avgCacheReadFrac =
    warmFracs.length > 0 ? warmFracs.reduce((a, b) => a + b, 0) / warmFracs.length : null;

  const avgUsage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const r of story) {
    const u = r.narrationUsage;
    if (!u) continue;
    avgUsage.input_tokens += u.input_tokens;
    avgUsage.output_tokens += u.output_tokens;
    avgUsage.cache_read_input_tokens =
      (avgUsage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    avgUsage.cache_creation_input_tokens =
      (avgUsage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  const n = Math.max(1, story.length);
  avgUsage.input_tokens /= n;
  avgUsage.output_tokens /= n;
  avgUsage.cache_read_input_tokens = (avgUsage.cache_read_input_tokens ?? 0) / n;
  avgUsage.cache_creation_input_tokens = (avgUsage.cache_creation_input_tokens ?? 0) / n;

  const projections = TIER_MENUS.narration.map((model) => {
    const perTurnUsd = estimateCostUsd(model, avgUsage) + avgNonNarrationUsd;
    return { model, perTurnUsd, perSessionUsd: perTurnUsd * turnsPerSession };
  });

  return {
    totalUsd,
    attributedUsd,
    overheadUsd: totalUsd - attributedUsd - harnessUsd,
    harnessUsd,
    turnsPerSession,
    avgNonNarrationUsd,
    avgCacheReadFrac,
    projections,
  };
}
