import { env } from "@/lib/env";

/**
 * Budget configuration (Commit 9).
 *
 * Two orthogonal controls:
 *   1. `getTurnRateCap()` — per-user per-UTC-minute turn cap. System
 *      accident-prevention guard (AIDM_TURNS_PER_MINUTE_CAP env, default
 *      6). Not a business control.
 *   2. `getWarnThresholds()` — fractions of the user's self-set daily
 *      cost cap at which the budget indicator flips colors. Hardcoded
 *      at 50% + 90% per user direction; two distinct warn points
 *      rather than a single 80% flag.
 *
 * There is no system-wide daily cost cap. `users.daily_cost_cap_usd`
 * is the user's opt-in ceiling; when null, no cost gate fires and the
 * warn thresholds have nothing to be a fraction of.
 */

export function getTurnRateCap(): number {
  return env.AIDM_TURNS_PER_MINUTE_CAP;
}

/**
 * Warn fractions for the budget indicator UI. 0.5 = yellow, 0.9 = red.
 * Hardcoded — if a user asks for different warn points later, push it
 * to `users.daily_cost_warn_thresholds` (or similar) rather than env.
 */
export const WARN_FRACTIONS = [0.5, 0.9] as const;

export function getWarnThresholds(): readonly [number, number] {
  return WARN_FRACTIONS;
}

/**
 * UTC minute bucket key — `YYYY-MM-DDTHH:MMZ`. Stable across DST,
 * timezone-agnostic, sorts lexicographically.
 */
export function minuteBucketKey(now: Date = new Date()): string {
  const iso = now.toISOString(); // `YYYY-MM-DDTHH:MM:SS.sssZ`
  return `${iso.slice(0, 16)}Z`; // `YYYY-MM-DDTHH:MMZ`
}

/**
 * UTC day bucket key — `YYYY-MM-DD`. Midnight UTC rolls the bucket.
 */
export function dayBucketKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Seconds until the next UTC minute boundary — used in the 429
 * retry-after payload so the client knows when to retry.
 */
export function secondsUntilNextMinute(now: Date = new Date()): number {
  const msIntoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  const msUntilNext = 60_000 - msIntoMinute;
  return Math.ceil(msUntilNext / 1000);
}

/**
 * ISO timestamp for the next UTC midnight — used in the 429 cost-cap
 * retry payload so the client knows when the daily ledger resets.
 */
export function nextMidnightUtcIso(now: Date = new Date()): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}
