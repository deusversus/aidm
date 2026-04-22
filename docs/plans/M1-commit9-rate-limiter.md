# M1 Commit 9 — rate limiter + user-set cost guardrail + budget UI

**Drafted 2026-04-22.** Expands `docs/plans/M1-closure.md §9` to file-level scope. Lands BEFORE Commit 8 so the eval harness can exercise the bypass flag. Spec derives from ROADMAP §M1 ("Rate limiter (Postgres counter); per-turn cost") — with the scope correction that **daily cost limits are user-set, not system-imposed** (business model is cost-forward + markup; we bill credits, we don't gate spend, users choose their own guardrail).

---

## Why

Today the app has no rate gate and no honest per-turn cost visibility. A runaway client or accidental infinite loop could burn unbounded $ against real providers before the user notices. ROADMAP §M1 lists the rate limiter as a deliverable. M1 cannot ship without it.

Per-minute turn rate is a **system accident-prevention guard** — no one is sending 6 messages a minute through this pipeline with good intent; the cap exists to stop runaway loops and fast-finger bugs, not to shape spending.

Per-day cost is a **user-configurable guardrail** — the business model (per `project_business_model.md`) is cost-forward + markup on owned provider keys; users pay for what they use. If a user wants to bound their own spending, they set `daily_cost_cap_usd` on their account. The system defaults to no cap. This differs from v3's framing and earlier M1-closure §9 wording; the closure doc's language is updated downstream.

Secondary: honest per-turn cost visibility. Today `turns.costUsd` captures KA's `total_cost_usd` only — pre-pass agents (Scenewright / IntentClassifier / OutcomeJudge / Validator / WorldBuilder / OverrideHandler) run through `_runner.ts` which throws away usage. Chronicler's cost is captured in-process but never written back to the turn row. So the surfaced cost is ~60% of actual spend.

---

## Scope

**Lands in this commit:**

1. **Cost aggregation across the turn.** `_runner.ts` returns `{ result, usage, costUsd }`. Turn workflow accumulates pre-pass cost + KA cost → writes to `turns.costUsd` (total-turn cost at `done`-event time, pre-Chronicler).
2. **Chronicler cost updates `turns` post-hoc.** After Chronicler's `after()` run completes, it updates the turn row: `costUsd += chroniclerCostUsd`. Daily ledger also gets the Chronicler delta.
3. **Two purpose-built tables** (rejecting the earlier polymorphic single-table suggestion):
   - `user_rate_counters` — integer counter per `(user_id, minute_bucket)` for the TPM gate. Atomic `INSERT ... ON CONFLICT DO UPDATE`. Bucket key is ISO8601 `YYYY-MM-DDTHH:MMZ` (UTC).
   - `user_cost_ledger` — USD running total per `(user_id, day_bucket)`. Same atomic increment pattern. Bucket key is `YYYY-MM-DD` (UTC). This is the forever-ledger of daily spend, useful later for billing reconciliation and user-facing spend history.
4. **Users table extension.** `users.daily_cost_cap_usd NUMERIC(10, 2)` — nullable column. Null = no cap (default for existing + new users). User sets via the UI.
5. **Pre-turn rate gate.** In `/api/turns/route.ts`, before streaming begins: look up `user_rate_counters[user, currentMinute]`. If `>= AIDM_TURNS_PER_MINUTE_CAP` (default 6), reject with HTTP 429 + JSON body `{ reason: "rate", retryAfterSec: <sec until next minute> }`.
6. **Pre-turn cost gate (conditional).** If `users.daily_cost_cap_usd IS NOT NULL`, look up `user_cost_ledger[user, today]`. If `>= cap`, reject with 429 + `{ reason: "cost_cap", usedUsd, capUsd, nextResetAt: <start of tomorrow UTC> }`. When cap is null, gate is skipped entirely.
7. **Atomic per-turn counter increment.** Increment `user_rate_counters[user, currentMinute]` atomically BEFORE streaming starts. No decrement on failure — bucket expires naturally.
8. **Post-turn cost increment.** After `runTurn` yields `done`, increment `user_cost_ledger[user, today]` by the turn's cost. After Chronicler finishes in `after()`, increment by its cost too.
9. **Eval bypass flag.** `runTurn({ bypassLimiter?: boolean })` threaded through. Route handler TypeScript type forbids setting it true from request input (no such pathway exists). Only the eval harness (Commit 8) and integration tests pass it.
10. **`/api/budget` endpoint.** GET returns `{ capUsd: number | null, usedUsd: number, percent: number | null, warn50: boolean, warn90: boolean, nextResetAt: string }`. When `capUsd` is null: `percent`, `warn50`, `warn90` all null/false. Authorizes on Clerk session.
11. **`/api/user/cap` endpoint.** POST `{ capUsd: number | null }` — authenticated user sets/clears their own cap. Zod-validated. Null clears the cap.
12. **`<BudgetIndicator />` component.** Compact readout in the play-screen header:
    - No cap set: shows today's spend as a bare number + "Set daily cap" link.
    - Cap set, under 50%: neutral progress bar with `$X.XX / $Y.YY`.
    - Between 50% and 90%: yellow.
    - ≥ 90%: red, with a "you're near your cap" tooltip.
    Refreshes by re-fetching `/api/budget` after each turn's `done` event.
13. **Minimal `/account/spending` page.** Single-field form: current cap display + input + "save" button + "clear cap" button. Submits to `/api/user/cap`. Enough surface to demonstrate the feature end-to-end; can be richer in M2+.
14. **Config env var.** `AIDM_TURNS_PER_MINUTE_CAP` (default `6`). No env for daily cost — that's a user setting, not a system knob.
15. **Tests.** Integration: burst 10 concurrent POSTs, exactly `cap` succeed, rest return 429. User-cap test: set cap to $0.10, run turn that spends $0.12, next turn rejects. Bypass test: passing `bypassLimiter: true` skips both gates. `/api/user/cap` authz test: user A cannot set user B's cap. UI tests: budget indicator renders three visual states + re-fetches on turn done.
16. **Migration** `drizzle/0009_<name>.sql` creating both tables + adding the users column. Backfill existing users to `daily_cost_cap_usd = NULL` implicitly (nullable column default).

**Explicitly NOT landing here:**

- Per-user monthly / lifetime caps — M2.5 billing substrate owns lifetime credits.
- Per-IP rate limiting — user-axis is right for Clerk-authenticated traffic.
- Admin override / bypass roles — no admin surface exists yet; M2+ concern.
- Cost attribution per-provider-per-tier — single aggregate `costUsd` is M1 granularity.
- Bucket GC cron — minute-buckets accumulate. Postpone until it matters (monthly GC lands with billing work). Surfaced in `M1-closure.md §Known debt`.
- Warn notifications (email, push) — `warn50` / `warn90` are only UI signals at M1.

---

## Schema

```sql
-- Atomic per-minute counter. Each row is one user's attempts in one UTC minute.
CREATE TABLE user_rate_counters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute_bucket TEXT NOT NULL,  -- 'YYYY-MM-DDTHH:MMZ'
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, minute_bucket)
);
CREATE INDEX user_rate_counters_user_idx
  ON user_rate_counters(user_id, minute_bucket DESC);

-- Running ledger of daily spend. Each row is one user's spend in one UTC day.
-- Purpose-built; useful for spend history UI, billing reconciliation later.
CREATE TABLE user_cost_ledger (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_bucket TEXT NOT NULL,  -- 'YYYY-MM-DD'
  total_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, day_bucket)
);
CREATE INDEX user_cost_ledger_user_idx
  ON user_cost_ledger(user_id, day_bucket DESC);

-- User's self-set daily spending guardrail. Null = no cap (default).
ALTER TABLE users
  ADD COLUMN daily_cost_cap_usd NUMERIC(10, 2);
```

No additional columns on `turns` — `costUsd` already holds total. Chronicler's post-hoc update is `UPDATE turns SET cost_usd = cost_usd + $chronicler_cost WHERE id = $turn_id` (idempotent-safe because Chronicler's `chronicledAt IS NULL` guard prevents double-run).

---

## File-level breakdown

### New files

- `src/lib/budget/config.ts` — env reads + constants (`getTurnRateCap()`, warn thresholds `[0.5, 0.9]`).
- `src/lib/budget/counters.ts` — `incrementRateCounter(userId, minute)` + `incrementCostLedger(userId, day, deltaUsd)` + `getUsage(userId)` returning current-minute count + current-day cost.
- `src/lib/budget/gate.ts` — `checkBudget(userId, opts: { bypass?: boolean })` → `{ ok: true } | { ok: false, reason: 'rate' | 'cost_cap', ... }`. Single read-and-check consumed by the route handler.
- `src/lib/budget/gate.test.ts` — unit tests with mocked counters (threshold edges, bypass honored, null cap path).
- `src/lib/budget/counters.test.ts` — real Drizzle tests against dev Postgres (atomic increment semantics, ON CONFLICT correctness, concurrency).
- `src/app/api/budget/route.ts` — GET current usage + cap + warn flags.
- `src/app/api/user/cap/route.ts` — POST to set/clear own cap.
- `src/components/budget-indicator.tsx` — header UI component.
- `src/app/(app)/account/spending/page.tsx` — minimal cap-setting form.
- `drizzle/0009_<name>.sql` — migration.

### Modified files

- `src/lib/env.ts` — add `AIDM_TURNS_PER_MINUTE_CAP` (numeric, default `6`). No daily cost env.
- `src/lib/state/schema.ts` — add `userRateCounters`, `userCostLedger` tables; add `dailyCostCapUsd` column to `users`.
- `src/lib/agents/_runner.ts` — return `{ result, costUsd, usage }` from `runStructuredAgent`. `costUsd` computed from the provider response's usage field + the campaign's model pricing (reuse `src/lib/llm/mock/pricing.ts`'s `estimateCostUsd` — it's already the canonical pricing table, just move / re-export from `src/lib/llm/pricing.ts`). Callers unpack `.result` (mechanical refactor across the consultant call sites).
- All structured-agent wrappers (`intent-classifier.ts`, `outcome-judge.ts`, `validator.ts`, `world-builder.ts`, `override-handler.ts`, `scale-selector-agent.ts` if it uses runner, `scenewright.ts`, KA consultants in `src/lib/agents/ka/`, Chronicler's `relationship-analyzer.ts`) — unpack `.result`; thread `.costUsd` back to caller via a new `recordCost(agentName, usd)` dep (added to `AgentDeps`).
- `src/lib/workflow/turn.ts` — initialize a `turnCostAccumulator`; each agent call contributes; sum + KA's cost → `turns.costUsd` at persist time. Add `bypassLimiter?: boolean` to `TurnInput`.
- `src/lib/workflow/chronicle.ts` — after Chronicler completes, UPDATE `turns.costUsd += chroniclerCost` AND `incrementCostLedger`.
- `src/app/api/turns/route.ts` — call `checkBudget(userId, { bypass: false })` before streaming begins; on rate/cap fail, return 429 with JSON body (not SSE). Increment rate counter atomically before streaming. Post-stream, increment cost ledger. TypeScript type forbids `bypass: true` from this handler (types-not-runtime guard).
- `src/app/(app)/campaigns/[id]/play/play-ui.tsx` — render `<BudgetIndicator />` in header; re-fetch `/api/budget` on `done` event.
- `src/lib/types/turn.ts` — add the 429 error payload shape.
- `src/lib/state/schema.ts` — extend `users` with new column.

### Test files

- `src/lib/workflow/__tests__/turn-budget.test.ts` — bypass honored; cost aggregated correctly.
- `src/app/api/turns/__tests__/budget-gate.test.ts` — rate gate + cap gate behavior; unknown user path.
- `src/app/api/user/cap/__tests__/authz.test.ts` — authz enforced.
- `src/components/__tests__/budget-indicator.test.tsx` — three visual states.
- `src/lib/budget/counters.test.ts` — real DB concurrency.

---

## Audit focus

- **Two-table design respected** — `user_rate_counters` and `user_cost_ledger` both present, both purpose-built. No polymorphic bucket-type column hiding in either.
- **User-set cap semantics.** Null cap → cost gate never fires (not "fires with cap = 0"). Cap = $0 means "no spending allowed" (a legitimate user choice that should gate even the first turn). Audit confirms both paths.
- **Atomic correctness.** ON CONFLICT DO UPDATE holds under burst-10 concurrent POSTs; test proves the cap is exact.
- **Bypass cannot leak from user input.** `bypassLimiter` typed so that `/api/turns/route.ts` literally cannot set it true. Grep for `bypassLimiter` assignments outside `evals/` and test files.
- **Warn thresholds at 50% + 90%.** Not 80%. Not one-threshold. UI transitions tested at boundary values.
- **Cost accounting rolls up.** Pre-pass + KA + Chronicler all contribute. Daily ledger doesn't double-count (ledger increments are additive, `turns.costUsd` is the authoritative turn-total).
- **Bucket key is UTC.** No off-by-one at midnight; no DST concerns.
- **Migrations are reversible.** 0009 down migration drops tables + column cleanly.
- **`/api/user/cap` authz hardened.** User A cannot set user B's cap; unauthenticated request returns 401.
- **Business-model alignment.** No system-default daily cap env var. Users not opted into cap have `daily_cost_cap_usd = null` and hit no cost gate.

---

## Risks

1. **Drizzle ON CONFLICT semantics.** `pgTable` with composite PK + `.onConflictDoUpdate({ target, set: { count: sql`${t.count} + 1` } })` — verify the generator emits correctly. Fall through to raw `sql` for the increment if needed.
2. **SSE + 429 shape.** Pre-turn gate returns 429 + JSON *before* switching to SSE. Route handler branches on gate result; only success paths open the stream.
3. **UI jitter on slow fetches.** BudgetIndicator re-fetches after each turn. Accept lag — advisory, not real-time.
4. **Cap = $0 vs. no cap.** Treat them distinctly: `null` = no cap (gate bypassed), `0` = zero budget (every turn rejected). Audit confirms correct branching.
5. **Moving pricing table.** `src/lib/llm/mock/pricing.ts` currently lives under mock/ but serves production too. Move to `src/lib/llm/pricing.ts` with re-export from mock/. Mechanical, but touches imports.
6. **Users column nullability in tests.** Fresh test users default to `daily_cost_cap_usd = null`; make sure fixtures seed this explicitly where relevant.

---

## Scope estimate

~1.5 days. ~10 new files, ~12 modified. Migration + per-commit audit. User-settings UI is minimal but real.

---

## Delivery order (within this commit)

1. Schema + migration → verify round-trip on dev DB.
2. Move pricing table to `src/lib/llm/pricing.ts`.
3. `_runner.ts` cost-return refactor + thread through consultants. Fix test breakage.
4. `src/lib/budget/*` — counters, gate, config. Unit + real-DB tests.
5. Turn workflow cost aggregation + persistence.
6. Chronicler post-hoc cost + ledger update.
7. API route pre-turn gate + post-turn increment.
8. `/api/budget` + `/api/user/cap` endpoints.
9. `<BudgetIndicator />` component + wire into play header.
10. `/account/spending` page.
11. `bypassLimiter` threading + tests.
12. `pnpm typecheck && pnpm lint && pnpm test` green.
13. Subagent audit on full stack.
14. Fix findings. Commit. Push.

---

*Revised 2026-04-22 after user scope corrections: daily cost is a user-set guardrail (not system cap), two purpose-built tables (not polymorphic single), warn at 50% + 90% (not one 80% threshold). Original draft committed as `3cf3d98` prior to corrections.*
