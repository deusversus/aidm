import { integer, real, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The axiom-6 write envelope, as columns (blueprint §6, §6.7). Spread into
 * EVERY layer table — the shared helper exists so omission can't happen
 * silently. `turnId` is the campaign-scoped turn sequence (0 = Session
 * Zero); `tombstonedAt` is the rewind substrate: rewind to turn N
 * tombstones every layer write with turnId > N. Reads go through
 * `notTombstoned()` (helpers.ts) — the only sanctioned read path.
 */
export const provenanceColumns = {
  turnId: integer().notNull(),
  provenance: text().notNull(),
  confidence: real().notNull(),
  tombstonedAt: timestamp({ withTimezone: true }),
};
