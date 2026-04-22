import { getTurnRateCap, nextMidnightUtcIso, secondsUntilNextMinute } from "./config";
import { getCurrentDayCost, getUserDailyCap, incrementRateCounter } from "./counters";

/**
 * Pre-turn budget gate (Commit 9).
 *
 * Two checks in order:
 *   1. **Cost cap** (non-mutating read) — current-day ledger vs.
 *      `users.daily_cost_cap_usd`. Only enforced when the user has
 *      opted into a cap (cap is null → skipped; cap = 0 → every turn
 *      gated). Runs first so a user who hits their cost cap doesn't
 *      burn a minute-counter slot they can't use anyway.
 *   2. **Rate** (atomic increment + post-check) — the increment IS
 *      the gate: we INSERT ... ON CONFLICT DO UPDATE +1 and then
 *      compare the returned new value to AIDM_TURNS_PER_MINUTE_CAP.
 *      This closes the TOCTOU gap that a read-then-increment pattern
 *      would leave open (N concurrent POSTs all seeing the pre-inc
 *      count and all passing the gate before any of them increments).
 *
 * `bypass: true` short-circuits both (no counter increment, no read).
 * Only the eval harness (Commit 8) and integration tests pass it.
 * The /api/turns/route.ts handler cannot set it true from user input
 * — route's request body schema doesn't include the field.
 */
export type GateResult =
  | { ok: true }
  | {
      ok: false;
      reason: "rate";
      retryAfterSec: number;
      rateCount: number;
      rateCap: number;
    }
  | {
      ok: false;
      reason: "cost_cap";
      usedUsd: number;
      capUsd: number;
      nextResetAt: string;
    };

export interface GateOptions {
  /**
   * Eval-mode bypass — skips both checks AND the rate-counter
   * increment. The route handler cannot pass true from user input
   * (body schema doesn't carry the flag). Only the eval harness
   * + integration tests set this.
   */
  bypass?: boolean;
  /** Inject `now` for deterministic tests. */
  now?: Date;
}

export async function checkBudget(userId: string, opts: GateOptions = {}): Promise<GateResult> {
  if (opts.bypass === true) return { ok: true };
  const now = opts.now ?? new Date();

  // 1. Cost cap gate — non-mutating read. Only fires when user has a cap.
  const capUsd = await getUserDailyCap(userId);
  if (capUsd !== null) {
    const usedUsd = await getCurrentDayCost(userId, now);
    if (usedUsd >= capUsd) {
      return {
        ok: false,
        reason: "cost_cap",
        usedUsd,
        capUsd,
        nextResetAt: nextMidnightUtcIso(now),
      };
    }
  }

  // 2. Rate gate — atomic increment returns the NEW count, which we
  // compare to the cap. This is the gate's only mutating operation;
  // the caller does NOT separately increment. No decrement on reject
  // — minute bucket expires naturally, and a slot burned on rejection
  // is fine (the cap is already exceeded for this minute either way).
  const newCount = await incrementRateCounter(userId, now);
  const rateCap = getTurnRateCap();
  if (newCount > rateCap) {
    return {
      ok: false,
      reason: "rate",
      retryAfterSec: secondsUntilNextMinute(now),
      rateCount: newCount,
      rateCap,
    };
  }

  return { ok: true };
}
