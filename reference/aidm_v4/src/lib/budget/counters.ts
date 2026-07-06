import { getDb } from "@/lib/db";
import { userCostLedger, userRateCounters, users } from "@/lib/state/schema";
import { and, eq, sql } from "drizzle-orm";
import { dayBucketKey, minuteBucketKey } from "./config";

/**
 * Atomic counter operations for the budget system (Commit 9).
 *
 * Both tables rely on PostgreSQL's `INSERT ... ON CONFLICT DO UPDATE`
 * pattern on the composite primary key so concurrent POSTs from the
 * same user serialize correctly under load. No advisory locks needed —
 * the upsert is atomic by itself.
 *
 * `userRateCounters` is an integer counter per (user, minute).
 * `userCostLedger` is a USD running total per (user, day).
 *
 * The two are purpose-built on separate tables rather than a single
 * polymorphic bucket table — the ledger is a forever-record useful
 * later for billing reconciliation and spend-history UI. Collapsing
 * them would confuse those purposes.
 */

/** Atomic increment of the (user, current-minute) rate counter. Returns the NEW value. */
export async function incrementRateCounter(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const db = getDb();
  const bucket = minuteBucketKey(now);
  const [row] = await db
    .insert(userRateCounters)
    .values({ userId, minuteBucket: bucket, count: 1 })
    .onConflictDoUpdate({
      target: [userRateCounters.userId, userRateCounters.minuteBucket],
      set: {
        count: sql`${userRateCounters.count} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: userRateCounters.count });
  return row?.count ?? 1;
}

/**
 * Read the current rate counter without mutating. Used by the pre-turn
 * gate before deciding whether to increment. Returns 0 when no row
 * exists (i.e. no calls this minute).
 */
export async function getCurrentRateCount(userId: string, now: Date = new Date()): Promise<number> {
  const db = getDb();
  const bucket = minuteBucketKey(now);
  const [row] = await db
    .select({ count: userRateCounters.count })
    .from(userRateCounters)
    .where(and(eq(userRateCounters.userId, userId), eq(userRateCounters.minuteBucket, bucket)))
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Atomic increment of the (user, today) cost ledger by `deltaUsd`.
 * Returns the new cumulative total. Safe to call with delta=0 (no-op
 * but still emits a row if none exists — sometimes useful for test
 * setup; callers can skip if they want).
 */
export async function incrementCostLedger(
  userId: string,
  deltaUsd: number,
  now: Date = new Date(),
): Promise<number> {
  const db = getDb();
  const bucket = dayBucketKey(now);
  // Numeric arithmetic preserves precision across the increment.
  const [row] = await db
    .insert(userCostLedger)
    .values({ userId, dayBucket: bucket, totalCostUsd: deltaUsd.toFixed(6) })
    .onConflictDoUpdate({
      target: [userCostLedger.userId, userCostLedger.dayBucket],
      set: {
        totalCostUsd: sql`${userCostLedger.totalCostUsd} + ${deltaUsd.toFixed(6)}`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ totalCostUsd: userCostLedger.totalCostUsd });
  return Number(row?.totalCostUsd ?? deltaUsd);
}

/**
 * Read the current-day cost total without mutating. Returns 0 when
 * no ledger row exists for today.
 */
export async function getCurrentDayCost(userId: string, now: Date = new Date()): Promise<number> {
  const db = getDb();
  const bucket = dayBucketKey(now);
  const [row] = await db
    .select({ totalCostUsd: userCostLedger.totalCostUsd })
    .from(userCostLedger)
    .where(and(eq(userCostLedger.userId, userId), eq(userCostLedger.dayBucket, bucket)))
    .limit(1);
  return Number(row?.totalCostUsd ?? 0);
}

/**
 * Read the user's self-set daily cap. Returns null when the user has
 * no cap (default — business model is cost-forward + markup, users
 * opt into their own ceiling). Cap = 0 is a legitimate user choice
 * (zero-spend day) distinct from null.
 */
export async function getUserDailyCap(userId: string): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ dailyCostCapUsd: users.dailyCostCapUsd })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return row.dailyCostCapUsd === null ? null : Number(row.dailyCostCapUsd);
}

/**
 * Set (or clear, by passing null) the user's daily cost cap. Cap = 0
 * is a legitimate user choice — do NOT treat 0 and null as equivalent.
 */
export async function setUserDailyCap(userId: string, capUsd: number | null): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ dailyCostCapUsd: capUsd === null ? null : capUsd.toFixed(2) })
    .where(eq(users.id, userId));
}

/**
 * Snapshot of a user's current budget state — the shape returned by
 * /api/budget for the BudgetIndicator UI.
 */
export interface BudgetSnapshot {
  capUsd: number | null;
  usedUsd: number;
  percent: number | null;
  warn50: boolean;
  warn90: boolean;
  rateCount: number;
  rateCap: number;
  nextResetAt: string;
}

export async function getBudgetSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<BudgetSnapshot> {
  const [capUsd, usedUsd, rateCount] = await Promise.all([
    getUserDailyCap(userId),
    getCurrentDayCost(userId, now),
    getCurrentRateCount(userId, now),
  ]);
  const percent = capUsd === null || capUsd === 0 ? null : usedUsd / capUsd;
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  return {
    capUsd,
    usedUsd,
    percent,
    warn50: percent !== null && percent >= 0.5,
    warn90: percent !== null && percent >= 0.9,
    rateCount,
    rateCap: (await import("./config")).getTurnRateCap(),
    nextResetAt: nextMidnight.toISOString(),
  };
}
