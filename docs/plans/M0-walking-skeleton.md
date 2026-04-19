# M0 — Walking Skeleton: Implementation Plan

**Milestone:** M0 (first of ten; see [ROADMAP §23](../../ROADMAP.md#23-milestones))
**Goal:** every piece of the v4 stack wired end-to-end and deployed to a live Railway URL. Sign-in works, DB is reachable, one Langfuse trace and one PostHog event captured. Nothing playable yet.
**Target duration:** 2–3 focused evenings.
**Acceptance:** clone → setup → deploy → sign in → see welcome message, in under 30 minutes for a fresh contributor.

**Deploy model (per user's established workflow from hvmsite + DDD):**
- **No Docker on dev machines.** Dev runs against Railway Postgres directly via its public URL.
- **GitHub push → Railway autodeploy** is the deploy loop. Every commit to `master` rebuilds.
- **Migrations run from dev machine** against the Railway DB (`pnpm db:push` locally). Migration files commit to git; Railway's rebuild does not re-run them (idempotent on next start).
- **One Railway project (`aidm`)**, one service (Next.js monolith), one Postgres plugin.

This collapses what the original draft treated as separate "local dev" and "production deploy" milestones into a single deploy target from commit 1. Ship-to-prod-from-week-one (ROADMAP §0.1 principle) applies literally.

---

## 1. Scope

### In scope

- Repo scaffold (done in commit 0).
- First Drizzle migration applied to local + prod Postgres, with pgvector extension enabled.
- Clerk auth end-to-end (magic link + OAuth). Webhook upserts into `users`.
- Langfuse hello-world trace captured from a manual Anthropic call.
- PostHog page-view capture + an intentional test-exception event.
- `/api/health` (liveness, no DB) and `/api/ready` (readiness: DB + Anthropic ping).
- Railway deploy on push to `master`, with migrations in the pre-deploy phase.
- CI: Biome lint + `tsc --noEmit` + Vitest (one smoke test) on every PR; Railway preview per PR.
- Initial Zod type contracts committed in `lib/types.ts` so future milestones have something to import. Unused at M0; load-bearing from M1.

### Out of scope for M0

- Any agent, any prompt, any narrative generation. (M1.)
- Session Zero. (M2.)
- Any memory retrieval. (M4.)
- shadcn/ui components beyond what's needed for the landing + sign-in pages.
- Moderation policy/filter code. (M2+; policy doc drafted at M2 per ROADMAP §16.)
- Stripe. (M9.)
- Evals harness beyond CI skeleton. (M1 ships first real evals.)

### What I can do vs. what needs the user

| Action | Me | User |
|---|---|---|
| Write code, configs, migrations | ✓ | |
| Run `pnpm` locally, git operations, push to `master` | ✓ | |
| Create Clerk / Langfuse / PostHog / Railway / Anthropic accounts | | ✓ |
| Paste API keys into `.env.local` and Railway env | | ✓ |
| Run `docker compose up` on your machine | | ✓ |
| Click "Approve" on a Clerk webhook subscription | | ✓ |
| Create the Railway project and link the GitHub repo | | ✓ |

---

## 2. Prerequisites

Before commit 2, you (jcettison) will want these in hand. I'll flag when each first becomes load-bearing.

| Account / tool | Tier | Needed at commit | Env vars |
|---|---|---|---|
| **Railway project + Postgres plugin** | Hobby ($5/mo) | **1 (DB is load-bearing immediately)** | `DATABASE_URL` from Postgres plugin |
| Anthropic API | pay-as-you-go | 4 (smoke ping) | `ANTHROPIC_API_KEY` |
| Google AI Studio | free | 4 (optional fast-tier ping) | `GOOGLE_API_KEY` |
| Clerk | free dev | 3 | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` |
| Langfuse Cloud | free | 5 | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` |
| PostHog Cloud | free | 5 | `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` |
| GitHub repo access | already have | 0 (done) | — |

**Critical path:** Railway first (blocks everything else — without the Postgres plugin, commit 2's migration has nowhere to land). Then Clerk and Anthropic in parallel (they unblock the bulk of work). Langfuse and PostHog together.

**Railway setup (one-time, ~10 min):**
1. `railway login` (already done per user).
2. From `C:/Users/admin/Downloads/aidm_v4`: `railway init` → name the project `aidm`, link to the `deusversus/aidm` GitHub repo, enable autodeploy on `master`.
3. Add the Postgres plugin: `railway add --plugin postgresql` (or via dashboard).
4. In Railway dashboard → Postgres → Variables tab: copy `DATABASE_PUBLIC_URL`, paste into local `.env.local` as `DATABASE_URL`.
5. One-time extension enablement: `railway connect postgres` (opens psql), run `CREATE EXTENSION IF NOT EXISTS vector;`, exit.

---

## 3. Commit plan

Each entry is one reviewable commit. Commits are ordered by dependency. I'll pause for your go-ahead between commits only if there's a blocker (missing key, design decision). Otherwise I'll move through them end-to-end.

### Commit 0 — `chore: init v4 walking skeleton` ✓ landed

Scaffold, deps, configs. No behavior. See commit [`77b64f4`](https://github.com/deusversus/aidm/commit/77b64f4).

---

### Commit 1 — `chore: align with railway-native workflow (no local docker)`

**Goal:** align repo with the user's established Railway deploy pattern from hvmsite + DDD. No Docker on dev machine; dev DB is the Railway Postgres public URL; GitHub push is the deploy trigger.

**Files touched:**
- **Delete** `docker-compose.yml` — not part of the workflow.
- `.env.example` — `DATABASE_URL` comment rewritten to point at Railway public URL pattern, with note distinguishing public (dev) from internal (Railway runtime).
- `README.md` — "Local dev" section rewritten. Replaces `docker compose up` with "paste Railway `DATABASE_PUBLIC_URL` into `.env.local`." Adds a "Deploy topology" section describing one-Railway-project / one-service / GitHub-push-deploy.
- `src/lib/db.ts` — adds graceful shutdown handler: on SIGTERM/SIGINT, `pool.end()` drains connections before `process.exit`. Guarded by `globalThis.__aidmShutdownRegistered` flag to survive dev hot reload without duplicate registration.
- `docs/plans/M0-walking-skeleton.md` — this file; reorders commits and adds the Railway-first prerequisite.

**Verification (local):**
1. `pnpm typecheck` — still green.
2. `pnpm lint` — still green.
3. `git status` — confirms `docker-compose.yml` deleted, 4 files modified, 0 files added.

**Acceptance:** Repo state reflects Railway-native workflow. `.env.example` and README unambiguously describe the expected dev setup. Graceful shutdown compiles and has no lint warnings.

**In parallel (you):** provision the `aidm` Railway project per §2's setup checklist. Paste `DATABASE_PUBLIC_URL` into `.env.local`. Enable `vector` extension via `railway connect postgres` → `CREATE EXTENSION vector;`.

**Risks:**
- Global shutdown registration pattern via `globalThis` is a mild anti-pattern but necessary for Next.js hot reload. Alternative patterns (module-level flag) don't survive HMR re-imports. Documented in the commit.

---

### Commit 2 — `feat(db): initial migration with pgvector`

**Goal:** Drizzle can generate and apply a migration that creates `users` + `campaigns` and relies on the `vector` extension. Applied to the Railway-managed Postgres.

**Files touched:**
- `drizzle/0000_init.sql` — generated via `pnpm db:generate`, hand-reviewed per ROADMAP §4.6. Adds `CREATE EXTENSION IF NOT EXISTS vector` at the top as a safety net (already enabled via psql in commit 1's setup; SQL is idempotent).
- `drizzle/meta/_journal.json` + `drizzle/meta/0000_snapshot.json` — generated.
- `src/lib/state/schema.ts` — no functional change expected; verify FK ordering.

**Verification:**
1. `pnpm db:generate` — produces `drizzle/0000_init.sql`.
2. Hand-review the SQL, commit.
3. `pnpm db:push` — applies against Railway Postgres (uses `DATABASE_URL` from `.env.local`).
4. `railway connect postgres` → `\dt` shows `users` + `campaigns`; `SELECT extname FROM pg_extension WHERE extname='vector';` returns a row.
5. `curl http://localhost:3000/api/ready` (after `pnpm dev`) returns `200` with `db: ok`.
6. `git push origin master` — Railway rebuilds; production `/api/ready` returns `200`.

**Acceptance:** both tables exist in Railway Postgres, `vector` extension present, `/api/ready` green locally AND on production URL after push.

**Risks:**
- **pgvector on Railway-managed Postgres.** Needs one-time `CREATE EXTENSION vector;` via psql (done in commit 1 setup). If Railway's default image doesn't include pgvector, fallback: deploy Railway's "pgvector" template or use a Postgres plugin with pgvector pre-installed. Decided live at setup time.
- Drizzle-generated SQL may not include extension creation — so the hand-added `CREATE EXTENSION` is important as a belt-and-suspenders safety net.

---

### Commit 3 — `feat(auth): wire Clerk end-to-end`

**Goal:** magic-link sign-in → `/campaigns` page shows `hello, {user.email}`. Webhook creates/updates a row in `users`.

**Prerequisites:** Clerk account + application created (5-min task for you); paste keys into `.env.local`.

**Auth methods enabled:** magic link (email) + Google OAuth. Both are first-class. Clerk handles the UX for both; user picks whichever is faster on a given day.

**Files touched:**
- `src/middleware.ts` — Clerk `clerkMiddleware()` protecting `(app)` route group.
- `src/app/(auth)/sign-in/[[...sign-in]]/page.tsx` — Clerk's `<SignIn />` (magic link + Google visible).
- `src/app/(auth)/sign-up/[[...sign-up]]/page.tsx` — Clerk's `<SignUp />` (magic link + Google visible).
- `src/app/(auth)/layout.tsx` — minimal auth shell.
- `src/app/(app)/layout.tsx` — authenticated shell; wraps `<ClerkProvider>`.
- `src/app/(app)/campaigns/page.tsx` — Server Component; uses `auth()` + greets user.
- `src/app/api/webhooks/clerk/route.ts` — verifies Svix signature, upserts `users`.
- `src/lib/auth.ts` — thin helper exposing `getCurrentUser()` for Server Components.
- `src/app/layout.tsx` — wrap body in `<ClerkProvider>`.
- `.env.example` — add `CLERK_WEBHOOK_SECRET`.

**Clerk dashboard config (you'll do once):** in the application's "User & Authentication → Email, Phone, Username" pane, enable Email magic link. In "Social Connections," enable Google. In "Webhooks," add an endpoint pointing to `{NEXT_PUBLIC_APP_URL}/api/webhooks/clerk` subscribed to `user.created` and `user.updated`; copy the signing secret into `CLERK_WEBHOOK_SECRET`.

**Verification (local):**
1. `pnpm dev`, navigate to `http://localhost:3000/campaigns` — redirected to Clerk sign-in.
2. Magic-link sign-in completes → land at `/campaigns` → see "hello, jcettison@gmail.com".
3. In a Clerk sandbox, trigger the webhook with `svix-cli` (or Clerk's test tool) → row appears in `users`.

**Acceptance:** sign-in works, webhook upserts, `auth()` returns the Clerk user in Server Components.

**Risks:**
- **Clerk middleware + App Router edge cases.** Their docs shifted in late 2025; the `clerkMiddleware()` helper (not `authMiddleware`) is current. Pinning `@clerk/nextjs@^6.0.0`.
- **Webhook signature verification.** Uses `svix` package. Must be added to deps — defer until this commit so we don't carry unused deps earlier.
- **FK timing.** `users.id` must be populated by webhook *before* any `campaigns` row can FK to it. At M0 we don't create campaigns yet, so this is theoretical; flag for M3.

---

### Commit 4 — `feat(llm): provider clients + anthropic smoke ping in /api/ready`

**Goal:** `/api/ready` pings Anthropic and returns `anthropic: "ok"` (or `"fail"`) alongside the DB check.

**Prerequisites:** `ANTHROPIC_API_KEY` in `.env.local`.

**Files touched:**
- `src/lib/llm/anthropic.ts` — thin singleton `Anthropic` client from env; exports `pingAnthropic()` which calls the cheapest model with a 1-token response.
- `src/lib/llm/openai.ts` — same shape for OpenAI (+ OpenRouter via `baseURL` swap).
- `src/lib/llm/google.ts` — same shape for Google.
- `src/lib/llm/index.ts` — re-exports + tier resolver (`resolveTier('fast') → { provider, model }`).
- `src/app/api/ready/route.ts` — adds Anthropic ping (with 3s timeout) to the checks map.

**Verification (local):**
1. `curl http://localhost:3000/api/ready` → `{"status":"ok","checks":{"db":"ok","anthropic":"ok"}}`
2. Temporarily blank the Anthropic key → `"anthropic":"fail"` and HTTP 503.

**Acceptance:** both checks run in parallel (`Promise.allSettled`), each has its own timeout, response ≤ 4s p95.

**Risks:**
- Anthropic API key format changes. Guarded by the SDK; if it fails, check fails, `/ready` returns 503 — exactly the intended behavior.
- Cold-start latency in serverless environments. Not a factor on Railway (long-running Node process).

---

### Commit 5 — `feat(observability): langfuse + posthog wired`

**Goal:** Langfuse captures one trace from a manual Anthropic call; PostHog captures page views and a test exception.

**Prerequisites:** Langfuse + PostHog project keys in `.env.local`.

**Files touched:**
- `src/lib/observability/langfuse.ts` — singleton Langfuse client; `trace()` helper.
- `src/lib/observability/posthog-node.ts` — server-side PostHog client (for route handlers / Server Actions).
- `src/components/posthog-provider.tsx` — client-side PostHog init; wraps `(app)` layout.
- `src/app/layout.tsx` — mount the provider.
- `scripts/langfuse-hello.ts` — one-off script: call Opus 4.7 with "say hi", wrap in a Langfuse span. Runs via `pnpm tsx scripts/langfuse-hello.ts`.
- `package.json` — `"hello:trace": "tsx scripts/langfuse-hello.ts"` script.

**Verification:**
1. `pnpm hello:trace` → see a trace with one span in the Langfuse dashboard.
2. Sign in → load `/campaigns` → see `$pageview` in PostHog live events.
3. Visit `/__test-exception` (temporary route that throws) → see `$exception` in PostHog with stack trace.

**Acceptance:** one trace in Langfuse; one pageview + one exception in PostHog. Remove the `__test-exception` route in the same commit after verifying.

**Risks:**
- PostHog SDK naming: server SDK is `posthog-node`, client is `posthog-js`. Easy to confuse; pinned both in `package.json`.
- Langfuse SDK in a Next.js Edge runtime would fail. All our Langfuse calls are in the Node runtime; guarded by `export const runtime = "nodejs"` on any route that touches it.

---

### Commit 6 — `feat(ci): vitest smoke test + hardened workflow`

TODO(M1): enable Railway PR previews from the project's dashboard (Settings → Environments → enable PR Environments). Native Railway feature; no repo workflow needed. Deferred from M0 because it's a one-click dashboard toggle with no code impact.

**Goal:** opening a PR triggers lint + typecheck + test + a Railway preview env with its own `/api/health` URL posted as a PR comment.

**Files touched:**
- `.github/workflows/ci.yml` — already exists; ensure it runs on PRs.
- `.github/workflows/deploy-preview.yml` — new. Uses Railway's PR-preview-environments feature (enabled in project settings). Railway creates a per-PR environment with its own Postgres; the workflow comments the preview URL on the PR.
- `tests/setup.ts` — minimal Vitest setup (loads `.env.test`).
- `src/lib/env.test.ts` — first real unit test: env parsing with a known-good input fixture and a known-bad one.
- `vitest.config.ts` — config.

**Verification:**
1. Open a trivial PR → CI runs, passes.
2. Railway posts a preview URL on the PR.
3. Hit the preview `/api/health` → 200.

**Acceptance:** CI green, preview URL live, one Vitest test passing.

**Risks:**
- **Railway preview env requires a separate Postgres per PR.** Railway supports this natively; just needs to be enabled in the project settings. 2-min task at setup time.
- **Preview env cost.** Railway's preview environments are free on the Hobby plan up to resource limits. At M0 traffic this is nothing to worry about.

---

### Commit 7 — `feat(types): core Zod schemas committed (unused at M0)`

*(Numbering unchanged — commit 7 remains the final M0 commit.)*

**Goal:** the soul-contracts from ROADMAP §5, §7, §10 live in `lib/types.ts` so M1 and M2 have something to import. Intentionally unused at M0.

**Files touched:**
- `src/lib/types/profile.ts` — `AnimeResearchOutput` schema: 11 DNA scales, power system (name/mechanics/limitations/tiers), canonical stat mapping (with method/display_scale/meta_resources), 15 trope flags, voice cards, author's voice, visual style, tone, combat style, power distribution, director personality.
- `src/lib/types/turn.ts` — `IntentOutput`, `OutcomeOutput`, `MemoryCandidate`, `OpeningStatePackage`, `DirectorOutput`.
- `src/lib/types/hybrid.ts` — `HybridProfileRequest` schema (primary + secondary media refs + blend intent text) — the contract the ProfileGenerator will consume at M2.
- `src/lib/types/index.ts` — barrel export.
- `src/lib/types.ts` — re-exports from `./types/index.ts`.
- `evals/golden/profiles/cowboy_bebop.yaml` — ported from v3 `profiles/al_1.yaml`.
- `evals/golden/profiles/solo_leveling.yaml` — ported from v3 `profiles/al_151807.yaml`.
- `src/lib/types/__tests__/profile.test.ts` — round-trip tests (covering both profiles individually AND the hybrid path):
  - Parse Cowboy Bebop YAML → Zod schema round-trip.
  - Parse Solo Leveling YAML → Zod schema round-trip (exercises canonical stat mapping: STR/AGI/VIT/INT/SENSE/LUK → D&D mapping).
  - Reject malformed profile (missing `power_system` field).
  - Assert defaults populate correctly when optional fields absent.
  - `HybridProfileRequest` round-trip: `{primary: "cowboy_bebop", secondary: "solo_leveling", blend_intent: "Bebop's noir pacing with Solo Leveling's power-fantasy arc"}` → validates against schema.

**Verification:**
1. `pnpm typecheck` green.
2. `pnpm test` green; 5 new tests pass.
3. `pnpm prompts:dump` (stub script) confirms no crash.

**Acceptance:** schemas compile, round-trip both real v3 profiles successfully. Canonical stat mapping parses correctly from the Solo Leveling YAML.

**Why this commit exists at M0:** by committing the contracts now, M1's first feature can do `import { IntentOutput } from "@/lib/types"` without rewiring. Reading real v3 profile YAMLs — specifically the two you've lived with most (Bebop + Solo Leveling) and a hybrid configuration — forces the schema to match v3's reality, not a sanitized approximation. Schema mismatches surface here, not at M2.

**Risks:**
- Porting v3 YAMLs may surface schema mismatches on landing. **This is a feature.** Fix the schema to match what v3 actually ships; don't sanitize the profile to fit a prettier schema. v3 is the spec (per §27).
- Solo Leveling's YAML may have extraction-fallback text in voice_cards ("speech patterns cannot be determined from source material"). The schema should accept this rather than treat it as missing data — it's a valid v3 output.

---

## 4. Definition of done

M0 is complete when ALL of the following hold:

- [ ] `https://<railway-domain>/api/health` returns 200.
- [ ] `https://<railway-domain>/api/ready` returns 200 with `db: ok` and `anthropic: ok`.
- [ ] Sign-in with magic link works on the production URL; `users` table has the row.
- [ ] One Langfuse trace visible from `pnpm hello:trace`.
- [ ] One PostHog page-view visible from a production sign-in.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` all green locally and in CI.
- [ ] Opening a PR triggers CI + Railway preview automatically.
- [ ] A fresh contributor with accounts pre-created could clone, `cp .env.example .env.local`, paste keys, `docker compose up`, `pnpm install && pnpm dev`, and see the app run in under 30 minutes.
- [ ] `docs/plans/M0-walking-skeleton.md` (this doc) has the "commit X landed" boxes checked.
- [ ] Retrospective written to `docs/retros/M0.md` (one page: what went well, what was harder than expected, what M1 inherits).

---

## 5. Risk log

Consolidated from per-commit risk notes; mitigations planned.

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| 1 | pgvector extension not auto-enabled on Railway Postgres | high (blocks commit 2) | medium | Manual `CREATE EXTENSION vector` via `railway connect postgres` at setup (commit 1 sidebar task); fallback to custom pgvector image plugin if not supported |
| 2 | Clerk middleware quirks on Next 15 App Router | medium (blocks sign-in) | medium | Pin `@clerk/nextjs@^6.0.0`; follow current `clerkMiddleware()` pattern; test on localhost before deploy |
| 3 | Tailwind 4 + PostCSS edge cases (brand-new at publish time) | low (cosmetic) | low | Vanilla `@tailwindcss/postcss` plugin; no custom PostCSS pipeline at M0 |
| 4 | Next 15 standalone output path diverges from Dockerfile | medium (build fails) | low | Verify `output: "standalone"` in `next.config.ts` and `.next/standalone/` layout on first local Docker build |
| 5 | Railway build timeout on first deploy (fresh pnpm cache) | low (retryable) | low | Railway caches between builds; first build is slow but subsequent are fast |
| 6 | Clerk redirect URLs not updated for prod domain | medium (auth broken on prod) | medium | Include in Railway setup checklist (commit 5); 2-min fix |
| 7 | NEXT_PUBLIC_* env baked at build, not runtime | low (config confusion) | low | Documented in commit 5 notes; set in Railway before first build |
| 8 | v3 profile YAML port (commit 7) surfaces schema mismatch | low (actually good — surfaces issues early) | high | Treat as a feature; adjust schema to match v3 reality |
| 9 | Provider SDK breaking changes in minor versions | low-medium | low | `^` ranges pinned; lockfile committed |

---

## 6. What comes after M0

M1 starts on the first agent: IntentClassifier (fast tier) → OutcomeJudge (thinking tier) → KeyAnimator (creative tier, streaming, 4-block cache). M0's Zod types in commit 7 are the first thing M1 imports. M0's `/api/ready` Anthropic ping is the first thing M1 tests against. M0's Langfuse trace helper becomes the parent span for every turn.

Nothing M0 ships is throwaway.

---

## 7. How to use this plan

- **You review it first.** If anything's wrong — wrong commit boundary, wrong risk estimate, missing prerequisite, disagree with Clerk as the auth choice — push back before commit 1.
- **I execute linearly unless blocked.** Between commits I'll post a one-line "landed X, starting Y" update. If I hit a blocker (missing key, unexpected error), I stop and surface it before continuing.
- **You handle external-account steps when they come up.** I'll flag each one explicitly ("pause — paste your Clerk keys into `.env.local` and say 'go'"). Nothing external runs without you. I'll generate `.env.local` for you to paste into, not manage it through a secrets manager.
- **Audit cadence.** You run a work → audit → work → audit/fix loop on every commit. Commits here are deliberately thorough (more coverage per audit) rather than maximally small. If an audit surfaces a fix, it lands as its own follow-up commit before the next feature commit.
- **This doc is a living artifact.** I'll check off commits as they land and update risk notes with what actually happened. By M0's retro, this file will read as a record of what was planned vs. what happened — useful input for M1's plan.
