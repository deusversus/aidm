import type { Db } from "@/lib/db";
import { players } from "@/lib/db/schema";
import { DEFAULT_THEME, type Theme, themeFromProfile } from "@/lib/theme";
import { type SQL, eq, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * The only sanctioned read path over layer tables (blueprint §6.7): a
 * tombstoned write is invisible to every consumer — retrieval, blocks,
 * Director, recap — while remaining in place for provenance. Compose into
 * every layer-table WHERE clause:
 *
 *   db.select().from(semanticMemories)
 *     .where(and(eq(semanticMemories.campaignId, id), notTombstoned(semanticMemories)))
 */
export function notTombstoned(table: { tombstonedAt: PgColumn }): SQL {
  return isNull(table.tombstonedAt);
}

/**
 * The §6.9 taste-note ceiling. A real budget (notes ride the Settei), and a
 * CODE one: the structured-output grammar strips `z.string().max()`, so a
 * schema bound could only ever fail the parse and destroy the artifact the
 * note rides on (diagnosed live 2026-08-01, session memo). Every writer states
 * the limit in its prompt and enforces it here — an over-budget note drops
 * with a warn; the memo, the resolution, and the close all survive.
 */
export const TASTE_NOTE_MAX = 240;

/**
 * The only sanctioned WRITE path for §6.9 taste notes (M2R R4 audit): an
 * ATOMIC jsonb append. The player profile is player-scoped — the SZ
 * compiler, session close, and booth close all write it, potentially for
 * different campaigns of the same player at once, and a read-modify-write
 * full replacement silently loses the losing writer's append (and would
 * clobber any future profile field besides). Notes are trimmed; empties
 * dropped.
 */
export async function appendPlayerTaste(
  // Pick: callable with the pool db OR a transaction handle (the SZ compiler
  // appends inside its compile tx).
  db: Pick<Db, "update">,
  playerId: string,
  notes: string[],
): Promise<void> {
  const cleaned = notes.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleaned.length === 0) return;
  await db
    .update(players)
    .set({
      profile: sql`jsonb_set(
        coalesce(${players.profile}, '{}'::jsonb),
        '{taste}',
        coalesce(${players.profile} -> 'taste', '[]'::jsonb) || ${JSON.stringify(cleaned)}::jsonb
      )`,
    })
    .where(eq(players.id, playerId));
}

/**
 * The §6.9 reading preference (M3R4 B5). Same atomic-jsonb discipline as the
 * taste append and for the same reason: the profile is player-scoped and other
 * writers (SZ compile, session close, booth close) append to it concurrently —
 * a read-modify-write full replacement would clobber their notes.
 */
export async function setPlayerTheme(
  db: Pick<Db, "update">,
  playerId: string,
  theme: Theme,
): Promise<void> {
  await db
    .update(players)
    .set({
      profile: sql`jsonb_set(
        coalesce(${players.profile}, '{}'::jsonb),
        '{theme}',
        ${JSON.stringify(theme)}::jsonb
      )`,
    })
    .where(eq(players.id, playerId));
}

/**
 * The read side (root layout + the settings drawer's source of truth). A player
 * with no row yet — the webhook hasn't fired, a fresh local session — reads as
 * the default rather than erroring: the theme is never worth a 500.
 */
export async function readPlayerTheme(db: Pick<Db, "select">, playerId: string): Promise<Theme> {
  const [row] = await db
    .select({ profile: players.profile })
    .from(players)
    .where(eq(players.id, playerId));
  return row ? themeFromProfile(row.profile) : DEFAULT_THEME;
}
