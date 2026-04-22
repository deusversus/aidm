# M1 Commit 9 — rate limiter + cost cap + budget UI

**Drafted 2026-04-22.** Expands `docs/plans/M1-closure.md §9` to file-level scope. Lands BEFORE Commit 8 so the eval harness can bypass. Spec derives from ROADMAP §M1 ("Rate limiter (Postgres counter); per-turn cost + per-user daily cap").

---

## Why

Today the app has no cost ceiling and no rate gate. A runaway client, a bad actor with a signed-in account, or a dev-loop mistake could burn unbounded $ against real providers. ROADMAP §M1 lists rate limiter + daily cost cap + budget UI as M1 deliverables. M1 cannot ship without these.

Secondary: honest per-turn cost visibility. Today `turns.costUsd` captures KA's `total_cost_usd` only — pre-pass agents (Scenewright / IntentClassifier / OutcomeJudge / Validator / WorldBuilder / OverrideHandler) run through `_runner.ts` which throws away usage. Chronicler's cost is captured in-process but never written back to the turn row. So the user sees ~60% of actual spend, undercounting what a daily cap has to gate.

---

## Scope

**Lands in this commit:**

1. **Cost aggregation across the turn.** `_runner.ts` returns `{ result, usage, costUsd }`. Turn workflow accumulates pre-pass cost + KA cost → writes to `turns.costUsd` (total-turn cost at `done`-event time, pre-Chronicler).
2. **Chronicler cost updates `turns` post-hoc.** After Chronicler's `after()` run completes, it updates the turn row: `costUsd += chroniclerCostUsd`; also populates `chronicledAt`.
3. **`user_usage_counters` table.** Single table keyed by `(user_id, bucket_type, bucket_key)` with atomic `INSERT ... ON CONFLICT DO UPDATE` semantics. Two bucket types: `turns_per_minute` (integer counter) and `cost_per_day` (numeric USD). Indexed for cheap lookup.
4. **Pre-turn rate check.** In `/api/turns/route.ts`, before calling `runTurn`: look up `turns_per_minute` for `(user, current-minute)`, reject with 429 if over cap. Look up `cost_per_day` for `(user, today)`, reject with 429 if over cap. Both in a single round-trip.
5. **Atomic per-turn counter increment.** Increment `turns_per_minute` for the current minute-bucket BEFORE starting the turn (so concurrent bursts serialize through Postgres's conflict resolution). No decrement on failure — the bucket expires naturally.
6. **Post-turn cost increment.** After `runTurn` yields `done`, increment `cost_per_day` by the turn's cost. After Chronicler finishes, increment by its cost too.
7. **Eval bypass flag.** `runTurn({ bypassLimiter?: boolean })` threaded through. Route handler NEVER sets it (TypeScript guards). Only the eval harness (Commit 8) + integration tests pass it.
8. **Budget indicator component.** New `src/components/budget-indicator.tsx` — compact progress bar showing today's cost vs. cap. Refreshed after each turn completes. Rendered in the `/campaigns/[id]/play` header.
9. **`/api/budget` endpoint** returning `{ usedUsd, capUsd, remainingUsd, percent, warn: boolean }`. `warn` flips true at 80%.
10. **Config env vars.** `AIDM_TURNS_PER_MINUTE_CAP` (default `6`), `AIDM_DAILY_COST_CAP_USD` (default `10.00`), `AIDM_DAILY_COST_WARN_THRESHOLD` (default `0.8`). Added to `envSchema` + `client-env.ts`-surface for UI (cap value; used computed per-fetch).
11. **Tests.** Integration test: burst 10 concurrent POSTs; exactly `cap` succeed, rest return 429. Daily cap test: seed usage row to 9.99, next turn rejects. Bypass test: passing `bypassLimiter: true` skips both gates. UI test: indicator renders + warns at 80% threshold.
12. **Migration** `drizzle/0009_<name>.sql` creating `user_usage_counters`.

**Explicitly NOT landing here:**

- Per-user monthly / lifetime caps — out of scope; M2.5 billing substrate handles lifetime credits.
- Per-IP rate limiting — Clerk auth is cheap enough that per-user is the right axis.
- Rate-limit bypass for specific power users / admin roles — no admin role exists yet; M2+ concern.
- Cost attribution per-provider-per-tier breakdowns — single aggregate `costUsd` is the M1 granularity. Finer splits land with billing in M2.5.
- Cleanup / GC of old bucket rows — minute buckets accumulate one row per user per minute. Postpone GC until it matters (monthly cron added with billing work).

---

## Schema

```sql
CREATE TABLE user_usage_counters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_type TEXT NOT NULL,     -- 'turns_per_minute' | 'cost_per_day'
  bucket_key TEXT NOT NULL,      -- '2026-04-22T15:42Z' or '2026-04-22'
  value NUMERIC(12, 6) NOT NULL DEFAULT 0,  -- integer count OR USD (6dp enough)
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, bucket_type, bucket_key)
);
CREATE INDEX user_usage_counters_user_type_idx
  ON user_usage_counters(user_id, bucket_type, bucket_key DESC);
```

Drizzle equivalent in `src/lib/state/schema.ts` with composite primary key via `pgTable`'s second arg.

No additional columns on `turns` — `costUsd` already holds total. Chronicler's post-hoc update is `UPDATE turns SET cost_usd = cost_usd + $chronicler_cost WHERE id = $turn_id`. Idempotent-safe because Chronicler uses `chronicledAt IS NULL` as its idempotency guard (won't run twice).

---

## File-level breakdown

### New files

- `src/lib/budget/caps.ts` — env reads + helpers (`getTurnRateCap()`, `getDailyCostCap()`, `getWarnThreshold()`).
- `src/lib/budget/counters.ts` — `incrementTurnCounter(userId, minute)`, `incrementCostCounter(userId, day, deltaUsd)`, `getCurrentUsage(userId)` returning both counters.
- `src/lib/budget/gate.ts` — `checkBudget(userId)` → `{ ok: true } | { ok: false, reason: 'rate' | 'cost', retryAfterSec?: number }`. The single read-and-check called by the route handler.
- `src/lib/budget/gate.test.ts` — unit tests (concurrency, threshold edge cases, bypass honored).
- `src/lib/budget/counters.test.ts` — real DB tests with Drizzle against dev Postgres (atomic increment semantics, ON CONFLICT correctness, cross-minute rollover).
- `src/app/api/budget/route.ts` — GET endpoint returning current usage snapshot.
- `src/components/budget-indicator.tsx` — UI component (progress bar + warn color).
- `drizzle/0009_<name>.sql` — migration.

### Modified files

- `src/lib/env.ts` — add `AIDM_TURNS_PER_MINUTE_CAP`, `AIDM_DAILY_COST_CAP_USD`, `AIDM_DAILY_COST_WARN_THRESHOLD` to schema.
- `src/lib/client-env.ts` — expose `NEXT_PUBLIC_DAILY_COST_CAP_USD` for UI (cap is non-secret; usage is fetched).
- `src/lib/state/schema.ts` — new `userUsageCounters` table.
- `src/lib/agents/_runner.ts` — extract cost from Anthropic / Google response usage, return alongside result. Update `runStructuredAgent` signature to return `{ result, costUsd, usage }`. Existing callers unpack `.result` (mechanical).
- All structured-agent wrappers that call `runStructuredAgent` (IntentClassifier, OutcomeJudge, Validator, WorldBuilder, OverrideHandler, Scenewright, all consultants in `src/lib/agents/ka/`, Chronicler's RelationshipAnalyzer) — unpack `.result` from the new return shape. `.costUsd` threaded back to caller via existing `trace`/`logger` deps + a new `recordCost` dep.
- `src/lib/workflow/turn.ts` — accumulate pre-pass + KA costs into a single `turnCostUsd` number; write to `turns.costUsd` at persist time. New `bypassLimiter` option on `TurnInput`. No rate check in the workflow itself (the route does that).
- `src/lib/workflow/chronicle.ts` — after Chronicler completes, UPDATE `turns.costUsd = cost_usd + chronicler_cost` AND increment daily cost counter.
- `src/app/api/turns/route.ts` — call `checkBudget(userId)` before `runTurn`; on fail, emit SSE `error` with payload `{ reason, retryAfterSec, cap }` and 429 status. Increment `turns_per_minute` atomically before streaming starts. Post-stream, increment `cost_per_day` by the turn's cost. `bypassLimiter: false` always from this handler (typed, so a refactor can't accidentally set it true).
- `src/app/(app)/campaigns/[id]/play/play-ui.tsx` — render `<BudgetIndicator />` in header. Re-fetch `/api/budget` after each turn's `done` event.
- `src/lib/types/turn.ts` — new event type for budget-triggered error.
- `scripts/mockllm.ts` — no changes (mock doesn't participate in budget).

### Test files

- `src/lib/workflow/__tests__/turn-budget.test.ts` — bypass flag respected; turn cost written to turns row.
- `src/app/api/turns/__tests__/budget-gate.test.ts` — pre-turn gate returns 429 over cap; under cap streams normally.
- `src/lib/budget/counters.test.ts` (real DB) — atomic semantics under concurrent INSERT.

---

## Audit focus

- **Atomic correctness.** The ON CONFLICT DO UPDATE pattern must hold under simulated concurrent POSTs from the same user. Test burst-10; exactly cap succeed.
- **Bypass cannot leak from user input.** `bypassLimiter` typed so that `/api/turns/route.ts` literally cannot set it true (not just "currently doesn't"). Audit should confirm by searching for any assignment of `bypassLimiter` outside `evals/` and test fixtures.
- **Cost accounting.** pre-pass + KA cost land in `turns.costUsd` pre-Chronicler. Chronicler's contribution updates the row post-hoc. Daily cap sums `turns.costUsd` with post-Chronicler state; no double-counting from incrementing the counter AND summing the column.
- **Minute-bucket key correctness.** UTC. No off-by-one at midnight boundaries.
- **Warn threshold actually flips the UI color.** Visual test: at 79% no warn, at 80%+ warn.
- **`/api/budget` authorizes.** Users can only read their own usage.
- **Env var validation.** Caps must parse as numbers; malformed values fail `envSchema.parse` at first-access time.
- **Bucket cleanup is deferred, not forgotten.** A tracking TODO or breadcrumb in `M1-closure.md §Known debt` saying "bucket GC cron not yet written; minute-buckets accumulate."

---

## Risks

1. **Drizzle ON CONFLICT semantics.** `pgTable` with composite PK + `.onConflictDoUpdate({ target, set: { value: sql`${t.value} + ${delta}` } })` — need to verify the SQL generator emits `EXCLUDED.value + t.value` correctly. Worst case, fall through to raw `sql` for the increment statement.
2. **SSE streaming + 429.** SSE convention is to always 200 and encode errors in the stream. Plan: pre-turn gate returns 429 *before* switching to SSE (route handler branches on gate result). After streaming starts, any error gets encoded as an `error` event at 200. Rate-limit rejections always hit pre-stream.
3. **UI jitter.** `BudgetIndicator` re-fetches after every turn. If the network is slow, the gauge visibly lags. Accept — this is an advisory, not a real-time display.
4. **Cost undercount still.** Even with this commit, consultant LLM calls inside KA (via Agent SDK's Agent tool) roll up into KA's `total_cost_usd`. Correct. But subagent definitions that spawn their OWN messages outside the turn's session will undercount. Audit: verify the KA's `total_cost_usd` subsumes consultants. Grep for any direct `anthropic.messages.create` outside `_runner.ts` + `key-animator.ts` + `chronicler.ts` in agent code.

---

## Scope estimate

~1–1.5 days of focused work. ~8 file additions, ~12 file modifications. Migration + one round of per-commit audit.

---

## Delivery order (within this single commit)

1. Schema + migration → verify round-trip on dev DB.
2. `src/lib/budget/*` — caps, counters, gate. Unit tests for gate; real-DB tests for counters.
3. `_runner.ts` cost-return refactor + thread through consultants. Fix any test breakage.
4. Turn workflow cost aggregation + persistence.
5. Chronicler post-hoc update of turns row + daily cost counter.
6. API route pre-turn gate + post-turn counter.
7. `/api/budget` endpoint + `<BudgetIndicator />` + wire into play UI.
8. `bypassLimiter` flag threading. Tests.
9. `pnpm typecheck && pnpm lint && pnpm test` green.
10. Subagent audit on full stack.
11. Fix findings. Commit. Push.

---

*Drafted 2026-04-22 from `docs/plans/M1-closure.md §9`. Commit lands before Commit 8 per M1-closure ordering.*
