import { type SQL, isNull } from "drizzle-orm";
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
