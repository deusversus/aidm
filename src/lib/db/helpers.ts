import type { Db } from "@/lib/db";
import { players } from "@/lib/db/schema";
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
