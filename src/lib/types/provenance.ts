import { z } from "zod";

/**
 * The universal write envelope (blueprint axiom 6, §6): every stored fact
 * carries where it came from, when (turn_id), and how confident we are.
 * Provenance is also what makes turns revocable — rewind to turn N
 * tombstones every write with turn_id > N (§6.7).
 *
 * The DB-side counterpart (C3) puts these as columns on every layer table,
 * plus `tombstoned_at`; reads go through the `notTombstoned()` helper.
 */

/**
 * Campaign-scoped turn sequence number. Turn 0 = Session Zero / opening
 * state; play turns count up from 1. Integer ordering is load-bearing for
 * rewind ("tombstone all writes with turn_id > N").
 */
export const TurnId = z.number().int().nonnegative();
export type TurnId = z.infer<typeof TurnId>;

/**
 * Where a write came from. Free-form but conventionally one of the writer
 * seams, e.g. "sz_extraction", "player_assertion", "ka_sidecar",
 * "compositor_distill", "director", "meta_booth", "gauge", "session_close".
 * C3 may tighten this to an enum once the writer set is wired.
 */
export const ProvenanceSource = z.string().min(1);

export const ProvenanceEnvelope = z.object({
  turn_id: TurnId,
  provenance: ProvenanceSource,
  confidence: z.number().min(0).max(1),
});

export type ProvenanceEnvelope = z.infer<typeof ProvenanceEnvelope>;
