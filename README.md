# AIDM v5

An engine for co-telling long-form fiction that stays true to a premise.

The spec-of-record is [`docs/plans/v5-blueprint.md`](docs/plans/v5-blueprint.md) (v3-final, signed 2026-07-06) — read §0 first. Per-milestone implementation plans live in [docs/plans/](docs/plans/). The past is reference, not spec: [`reference/aidm_v3/`](reference/aidm_v3/) holds the Python predecessor (the empirical record), [`reference/aidm_v4/`](reference/aidm_v4/) the shelved 2026 TypeScript map.

## Stack

TypeScript · Next.js 15 (App Router) · React 19 · Tailwind 4 · Drizzle ORM · Postgres 16 + pgvector · Claude Agent SDK (Anthropic-only generation) · Voyage embeddings · Clerk · Langfuse · PostHog · Railway.

## Deploy topology

One Railway project (`aidm`). `master` autodeploys on push to GitHub. The Railway-managed Postgres plugin provides `DATABASE_URL` at runtime (injected automatically). Local development runs against the **same** Railway Postgres via its public URL — no local Docker required. v5 uses a fresh database on that instance; the v4 database is untouched reference data.

## Local dev

Requires Node 22+ and the Railway project (Postgres plugin provisioned).

```sh
corepack enable                   # first time only — activates pnpm
cp .env.example .env.local        # paste keys (see .env.example comments)
pnpm install
pnpm dev                          # http://localhost:3000
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` | Next.js dev server / production build |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Biome · tsc strict · Vitest |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migration diff / apply |
| `pnpm db:studio` | Drizzle Studio GUI |
| `pnpm langfuse:latest` | Latest-trace diagnostic (tier / model / cost / latency) |

### Migration workflow

Migrations run from the **dev machine** against the Railway Postgres, not on Railway itself (the runner image has no devDeps). After editing `src/lib/db/schema.ts`: `pnpm db:generate` → hand-review the SQL → `pnpm db:migrate` → commit `drizzle/` → push.
