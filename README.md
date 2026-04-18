# AIDM v4

Anime-themed long-horizon single-player tabletop RPG dungeon master.

See [ROADMAP.md](./ROADMAP.md) for the master design document. See the [`v3`](https://github.com/deusversus/aidm/tree/v3) branch for the Python predecessor that v4 reincarnates in 2026 primitives.

## Stack

TypeScript · Next.js 15 (App Router) · React 19 · Tailwind 4 · Drizzle ORM · Postgres 16 + pgvector · Mastra · Claude Agent SDK · Clerk · Langfuse · PostHog · Railway.

## Local dev

Requires Node 22+ and Docker.

```sh
corepack enable                   # first time only
cp .env.example .env.local        # fill in keys
docker compose up -d              # Postgres + pgvector
pnpm install
pnpm db:push                      # apply schema to local DB
pnpm dev                          # http://localhost:3000
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm lint` | Biome lint check |
| `pnpm typecheck` | `tsc --noEmit` strict |
| `pnpm test` | Vitest unit/integration |
| `pnpm db:generate` | Generate migration from schema diff |
| `pnpm db:push` | Apply schema directly (dev only) |
| `pnpm db:migrate` | Run migrations (prod) |
| `pnpm db:studio` | Drizzle Studio GUI |
| `pnpm eval` | Run eval harness (full) |
| `pnpm eval:fast` | Run eval smoke subset |

## Repository layout

See [ROADMAP §3.3](./ROADMAP.md#33-repo-layout).
