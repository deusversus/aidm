# AIDM v4

Anime-themed long-horizon single-player tabletop RPG dungeon master.

See [ROADMAP.md](./ROADMAP.md) for the master design document and [docs/plans/](./docs/plans/) for per-milestone implementation plans. The [`v3`](https://github.com/deusversus/aidm/tree/v3) branch holds the Python predecessor v4 reincarnates in 2026 primitives.

## Stack

TypeScript · Next.js 15 (App Router) · React 19 · Tailwind 4 · Drizzle ORM · Postgres 16 + pgvector · Mastra · Claude Agent SDK · Clerk · Langfuse · PostHog · Railway.

## Deploy topology

One Railway project (`aidm`). `master` autodeploys on push to GitHub. The Railway-managed Postgres plugin provides `DATABASE_URL` at runtime (injected automatically). Local development runs against the **same** Railway Postgres via its public URL — no local Docker required.

## Local dev

Requires Node 22+ and a Railway project with the Postgres plugin provisioned (see below).

```sh
corepack enable                   # first time only — activates pnpm
cp .env.example .env.local        # paste keys (see below)
pnpm install
pnpm db:push                      # apply schema to the Railway Postgres
pnpm dev                          # http://localhost:3000
```

### Getting `DATABASE_URL`

1. Railway dashboard → `aidm` project → Postgres plugin → **Variables** tab.
2. Copy the `DATABASE_PUBLIC_URL` value (starts with `postgresql://`, ends with `.proxy.rlwy.net:<port>/railway`).
3. Paste into `.env.local` as `DATABASE_URL=...`.

Internal `DATABASE_URL` (with `postgres.railway.internal`) is set automatically when the app runs on Railway — never paste that into `.env.local`.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm lint` | Biome lint check |
| `pnpm typecheck` | `tsc --noEmit` strict |
| `pnpm test` | Vitest unit/integration |
| `pnpm db:generate` | Generate migration from schema diff |
| `pnpm db:push` | Apply schema directly (dev) |
| `pnpm db:migrate` | Run migrations (prod-style, idempotent) |
| `pnpm db:studio` | Drizzle Studio GUI |
| `pnpm eval` | Run eval harness (full) |
| `pnpm eval:fast` | Run eval smoke subset |

## Repository layout

See [ROADMAP §3.3](./ROADMAP.md#33-repo-layout).
