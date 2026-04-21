import { type ArcTrigger, type ChroniclerDeps, runChronicler } from "@/lib/agents/chronicler";
import type { Db } from "@/lib/db";
import { campaigns, turns } from "@/lib/state/schema";
import type { AidmToolContext } from "@/lib/tools";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveModelContext } from "./turn";

/**
 * Chronicler wrapper — FIFO-per-campaign serialization + idempotency guard +
 * error swallow. Called from the SSE route handler's `after()` callback so
 * the user's done event has already flushed before Chronicler starts.
 *
 * Design decisions locked at 7.4:
 *
 *   1. **Advisory lock namespace.** We use a *different* namespace from
 *      the turn-pipeline advisory lock (`turn.ts::campaignToLockKeys`)
 *      so Chronicler doesn't block the next turn's pre-pass. The
 *      Chronicler lock only serializes other Chronicler runs for the
 *      same campaign — turn N+1 can START while turn N's Chronicler is
 *      still running; only turn N+1's Chronicler must wait. The caller
 *      gets FIFO ordering of chronicling (turn N's writes land before
 *      N+1's) without blocking the next narrative turn.
 *
 *   2. **Idempotency.** `turns.chronicled_at IS NULL` is the guard. If
 *      a retried Chronicler finds the timestamp set, it returns
 *      early. This protects non-idempotent writes (record_relationship_event
 *      which is append-only; adjust_spotlight_debt which uses SQL
 *      `debt + delta`) from double-application.
 *
 *   3. **Error swallow.** Chronicler failures don't retroactively
 *      fail the turn — the player already saw the narrative. We log
 *      the error + leave `chronicled_at` null (so a future retry could
 *      run if we add an admin endpoint). The turn data itself is
 *      already committed to the turns row.
 *
 *   4. **Blocking lock.** We use `pg_advisory_lock` (not _try) — turn
 *      N+1's Chronicler WAITS for N's to finish. On Railway's long-
 *      running container this is fine. On serverless, `after()`'s
 *      host still counts against the function's lifetime, but
 *      Chronicler is ~fast-tier latency (<5s typical), so the wait
 *      cost is bounded.
 */

export interface ChronicleTurnInput {
  turnId: string;
  campaignId: string;
  userId: string;
  turnNumber: number;
  playerMessage: string;
  narrative: string;
  intent: import("@/lib/types/turn").IntentOutput;
  outcome: import("@/lib/types/turn").OutcomeOutput | null;
  /**
   * Arc-level writes gating. Caller decides. M1 heuristic (in route
   * handler): `"session_boundary"` if turn is first/last of a session,
   * `"hybrid"` if turn.intent.epicness >= 0.6 and turnNumber % 3 === 0,
   * else `null`. Lands in Commit 7.4's wiring spot.
   */
  arcTrigger: ArcTrigger;
}

export interface ChronicleTurnDeps extends ChroniclerDeps {
  db: Db;
  /** Override the base lock keys namespace offset for tests (avoid collision). */
  _lockNamespaceOffset?: number;
}

/**
 * Separate namespace for the Chronicler lock so it doesn't collide with
 * the turn-pipeline lock (`turn.ts::campaignToLockKeys`). That lock uses
 * the campaignId's hash directly; we XOR-fold the upper 32 bits with a
 * constant to shift to a new namespace. Chronicler and turn-pipeline
 * can both be acquired simultaneously for different work on the same
 * campaign without deadlock.
 */
const CHRONICLER_LOCK_NAMESPACE_XOR = 0x43_48_52_4e; // "CHRN"

function chroniclerLockKeys(
  campaignId: string,
  offset = CHRONICLER_LOCK_NAMESPACE_XOR,
): [number, number] {
  const hex = campaignId.replace(/-/g, "");
  const upper = (Number.parseInt(hex.slice(0, 8), 16) | 0) ^ offset;
  const lower = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [upper, lower];
}

async function acquireChroniclerLock(db: Db, campaignId: string, offset?: number): Promise<void> {
  const [k1, k2] = chroniclerLockKeys(campaignId, offset);
  // Blocking acquisition — turn N+1's Chronicler waits for N's to finish.
  await db.execute(sql`SELECT pg_advisory_lock(${k1}::int, ${k2}::int)`);
}

async function releaseChroniclerLock(db: Db, campaignId: string, offset?: number): Promise<void> {
  const [k1, k2] = chroniclerLockKeys(campaignId, offset);
  await db.execute(sql`SELECT pg_advisory_unlock(${k1}::int, ${k2}::int)`);
}

/**
 * Run Chronicler for a persisted turn. Safe to call N times — the
 * idempotency guard skips reruns. Throws never; logs and returns
 * silently on failure so the caller's `after()` callback exits clean.
 *
 * Returns a status tag for observability + tests.
 */
export async function chronicleTurn(
  input: ChronicleTurnInput,
  deps: ChronicleTurnDeps,
): Promise<"ok" | "already_chronicled" | "failed" | "skipped_non_continue"> {
  const logger = deps.logger ?? ((level, msg, meta) => console.log(`[${level}] ${msg}`, meta));
  const db = deps.db;

  await acquireChroniclerLock(db, input.campaignId, deps._lockNamespaceOffset);
  try {
    // Idempotency check: was this turn already chronicled?
    const [existing] = await db
      .select({ chronicledAt: turns.chronicledAt })
      .from(turns)
      .where(eq(turns.id, input.turnId))
      .limit(1);
    if (!existing) {
      logger("warn", "chronicleTurn: turn row not found", { turnId: input.turnId });
      return "failed";
    }
    if (existing.chronicledAt !== null) {
      logger("info", "chronicleTurn: already chronicled, skipping", {
        turnId: input.turnId,
        turnNumber: input.turnNumber,
      });
      return "already_chronicled";
    }

    // Load the campaign fresh for modelContext. Chronicler-time is
    // post-turn, so a settings change during the turn is fine to pick
    // up on the background pass.
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, input.campaignId),
          eq(campaigns.userId, input.userId),
          isNull(campaigns.deletedAt),
        ),
      )
      .limit(1);
    if (!campaign) {
      logger("warn", "chronicleTurn: campaign not found (deleted or transferred?)", {
        campaignId: input.campaignId,
      });
      return "failed";
    }

    // resolveModelContext always returns a config (falls back to
    // anthropicFallbackConfig internally on parse failure / missing fields).
    const modelContext = resolveModelContext(campaign.settings, logger);

    const toolContext: AidmToolContext = {
      campaignId: input.campaignId,
      userId: input.userId,
      db,
      trace: deps.trace,
    };

    await runChronicler(
      {
        turnNumber: input.turnNumber,
        playerMessage: input.playerMessage,
        narrative: input.narrative,
        intent: input.intent,
        outcome: input.outcome,
        arcTrigger: input.arcTrigger,
        modelContext,
        toolContext,
      },
      {
        logger: deps.logger,
        trace: deps.trace,
        recordPrompt: deps.recordPrompt,
        queryFn: deps.queryFn,
      },
    );

    // Mark as chronicled. Tightly scoped to the just-processed turn.
    await db.update(turns).set({ chronicledAt: new Date() }).where(eq(turns.id, input.turnId));

    logger("info", "chronicleTurn: ok", {
      turnId: input.turnId,
      turnNumber: input.turnNumber,
    });
    return "ok";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger("error", "chronicleTurn: failed (swallowed; turn state unchanged)", {
      turnId: input.turnId,
      turnNumber: input.turnNumber,
      error: errMsg,
    });
    return "failed";
  } finally {
    // Release the lock even on error so the next turn's Chronicler
    // can proceed. PG releases on connection drop anyway, but explicit
    // release is tidy.
    await releaseChroniclerLock(db, input.campaignId, deps._lockNamespaceOffset).catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Heuristic for arc-level write trigger. Called by the SSE route handler
 * to decide whether to pass `arcTrigger: "hybrid"` vs `null`.
 *
 * M1 rule:
 *   - Epicness >= 0.6 AND turnNumber % 3 === 0 → "hybrid"
 *   - Otherwise null
 * Session-boundary detection lands when session-tracking does (post-M1);
 * this function conservatively never returns "session_boundary" at M1.
 */
export function computeArcTrigger(intentEpicness: number, turnNumber: number): ArcTrigger {
  if (intentEpicness >= 0.6 && turnNumber % 3 === 0) return "hybrid";
  return null;
}
