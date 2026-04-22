/**
 * Budget module (Commit 9) — rate-limit + user-set cost guardrail.
 *
 * Public surface:
 *   - `checkBudget(userId, { bypass? })` → pre-turn gate used by the
 *     /api/turns route handler and the eval harness (with bypass).
 *   - `incrementRateCounter(userId)` → called atomically after a
 *     successful pre-turn gate, before streaming begins.
 *   - `incrementCostLedger(userId, deltaUsd)` → called at turn done
 *     and at Chronicler done to roll up spend into the daily ledger.
 *   - `getBudgetSnapshot(userId)` → powers /api/budget for the UI.
 *   - `setUserDailyCap(userId, cap)` → powers /api/user/cap for the
 *     /account/spending page.
 *
 * Pricing computations live in `@/lib/llm/pricing`; the budget module
 * consumes that for rate limiting and the ledger, but does not own it.
 */

export { getTurnRateCap, getWarnThresholds, WARN_FRACTIONS } from "./config";
export {
  type BudgetSnapshot,
  getBudgetSnapshot,
  getCurrentDayCost,
  getCurrentRateCount,
  getUserDailyCap,
  incrementCostLedger,
  incrementRateCounter,
  setUserDailyCap,
} from "./counters";
export { checkBudget, type GateOptions, type GateResult } from "./gate";
