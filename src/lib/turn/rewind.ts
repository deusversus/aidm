import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  arcs,
  campaigns,
  compactedBeats,
  consequences,
  criticalFacts,
  entities,
  entityVersions,
  episodicRecords,
  heatBoosts,
  overrides,
  pencilMarks,
  pins,
  quests,
  rewinds,
  seeds,
  semanticMemories,
  sessionRecords,
  stateSnapshots,
  turns,
} from "@/lib/db/schema";
import { DirectionState, rewindDirectionState } from "@/lib/types/direction";
import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

/**
 * Rewind (blueprint §6.7): turns are revocable. Rewind to turn N tombstones
 * every layer write with turn_id > N across all campaign-scoped layer tables —
 * the write stays in place for provenance (§6.7) but is invisible behind
 * notTombstoned() — deletes the dead-timeline spine (turns rows and the
 * unapplied heat-boost accumulator past N), restores mechanical state from the
 * nearest snapshot ≤ N and replays G1 resource spends forward, and logs the
 * event. Pure code, no model calls — rewind is for regret and for testing.
 *
 * Canonical shapes fixed here (the Compositor's G1 must align):
 *   - snapshot payload:  { entities: { <entityId>: entityState } }
 *   - resource state:    entityState.resources = { MP: { current, max }, ... }
 *   - the resourced actor is the player-character entity: entityType === "player".
 */

// Every campaign-scoped layer table that carries the provenance envelope. Two
// envelope-carrying tables are deliberately absent: canon_chunks is
// profile-scoped (cross-campaign, cached permanently — NEVER touched by a
// campaign rewind), and entity_versions is scoped through its parent entity,
// so it is tombstoned via a subquery below.
const CAMPAIGN_LAYER_TABLES = [
  compactedBeats,
  episodicRecords,
  semanticMemories,
  entities,
  quests,
  arcs,
  seeds,
  consequences,
  pencilMarks,
  sessionRecords,
  criticalFacts,
  overrides,
  pins,
] as const;

/** Statuses meaning a turn is still open (§5.7); a rewind mid-turn is rejected. */
export const OPEN_TURN_STATUSES = [
  "queued",
  "phase_a_complete",
  "phase_b_complete",
  "failed",
] as const;

/** The play view's bounded-rewind depth (§6.7); deeper is a studio-view op later. */
export const MAX_PLAY_VIEW_REWIND = 10;

export type RewindGuardResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * The bounded-UX guard (§6.7), factored out of the route so it is unit-testable
 * without an HTTP surface. `currentMax` is the campaign's latest turn number;
 * `hasOpenTurn` is whether any turn sits in an OPEN_TURN_STATUSES state.
 */
export function checkRewindGuards(params: {
  toTurn: number;
  currentMax: number;
  hasOpenTurn: boolean;
}): RewindGuardResult {
  const { toTurn, currentMax, hasOpenTurn } = params;
  if (!Number.isInteger(toTurn) || toTurn < 0) {
    return { ok: false, status: 400, error: "toTurn must be a non-negative integer" };
  }
  if (hasOpenTurn) {
    return { ok: false, status: 409, error: "a turn is in progress — rewind once it lands" };
  }
  if (toTurn >= currentMax) {
    return { ok: false, status: 400, error: "nothing after that turn to rewind" };
  }
  if (currentMax - toTurn > MAX_PLAY_VIEW_REWIND) {
    return {
      ok: false,
      status: 400,
      error: `rewind is bounded to ${MAX_PLAY_VIEW_REWIND} turns from the play view; deeper rewinds are a studio-view operation`,
    };
  }
  return { ok: true };
}

type ResourcePool = { current: number; max: number };
type EntityState = { resources?: Record<string, ResourcePool>; [k: string]: unknown };
type ResourceSpend = { resource: string; amount: number };
type SnapshotPayload = { entities?: Record<string, EntityState> };

export async function rewindCampaign(
  db: Db,
  campaignId: string,
  toTurn: number,
  reason?: string,
): Promise<{ tombstonedCount: number; snapshotTurn: number | null; nonReversible: string[] }> {
  // CALLER CONTRACT: drain G2 first (the route does — settleG2IfPending). A
  // detached settle racing this sweep would write ghost layer rows for an
  // un-happened turn AFTER the tombstone pass (C6 audit). This function
  // stays pure code (no model calls), so the drain lives at the entry point.
  return db.transaction(async (tx) => {
    const now = new Date();

    // 1. Tombstone every campaign-scoped layer write past N (§6.7). The row
    //    remains for provenance; notTombstoned() hides it from every reader.
    let tombstonedCount = 0;
    for (const table of CAMPAIGN_LAYER_TABLES) {
      const res = await tx
        .update(table)
        .set({ tombstonedAt: now })
        .where(
          and(
            eq(table.campaignId, campaignId),
            gt(table.turnId, toTurn),
            isNull(table.tombstonedAt),
          ),
        );
      tombstonedCount += res.rowCount ?? 0;
    }

    // entity_versions carries the envelope but is scoped through its parent
    // entity: tombstone the versions whose parent belongs to this campaign.
    const versionRes = await tx
      .update(entityVersions)
      .set({ tombstonedAt: now })
      .where(
        and(
          gt(entityVersions.turnId, toTurn),
          isNull(entityVersions.tombstonedAt),
          inArray(
            entityVersions.entityId,
            tx
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.campaignId, campaignId)),
          ),
        ),
      );
    tombstonedCount += versionRes.rowCount ?? 0;

    // Roll each surviving entity's living block BACK to its newest surviving
    // version — tombstoning the version rows alone left the block poisoned
    // with un-happened enrichment (C6 audit). Creation writes version 1
    // (g1/ingestion), so a surviving entity always has a base to restore.
    const survivors = await tx
      .select({ id: entities.id, block: entities.block })
      .from(entities)
      .where(and(eq(entities.campaignId, campaignId), notTombstoned(entities)));
    for (const s of survivors) {
      const [newest] = await tx
        .select({ block: entityVersions.block })
        .from(entityVersions)
        .where(and(eq(entityVersions.entityId, s.id), isNull(entityVersions.tombstonedAt)))
        .orderBy(desc(entityVersions.version))
        .limit(1);
      // No surviving version = a pre-versioning legacy row — leave it be.
      if (newest && newest.block !== s.block) {
        await tx.update(entities).set({ block: newest.block }).where(eq(entities.id, s.id));
      }
    }

    // 1b. DirectionState's turn-anchored fields clamp to the surviving
    //     timeline (C8 re-audit): a stale last_sample_turn silently disabled
    //     the Sakkan's same-turn guard, and a stale last_director_turn made
    //     turns_since negative — both engines dead until play re-passed the
    //     pre-rewind high-water mark. Same transaction as the sweep.
    const [campaignRow] = await tx
      .select({ directionState: campaigns.directionState })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (campaignRow?.directionState) {
      const parsed = DirectionState.safeParse(campaignRow.directionState);
      if (parsed.success) {
        await tx
          .update(campaigns)
          .set({ directionState: rewindDirectionState(parsed.data, toTurn) })
          .where(eq(campaigns.id, campaignId));
      }
    }

    // 2. heat_boosts has no tombstone columns — it is an unapplied batch (the
    //    C4 write-only seam). Dead-timeline boosts are simply deleted.
    await tx
      .delete(heatBoosts)
      .where(and(eq(heatBoosts.campaignId, campaignId), gt(heatBoosts.turnNumber, toTurn)));

    // 3. Restore mechanical state from the nearest snapshot ≤ N (§6.7).
    const [snapshot] = await tx
      .select({ turnNumber: stateSnapshots.turnNumber, state: stateSnapshots.state })
      .from(stateSnapshots)
      .where(and(eq(stateSnapshots.campaignId, campaignId), lte(stateSnapshots.turnNumber, toTurn)))
      .orderBy(desc(stateSnapshots.turnNumber), desc(stateSnapshots.createdAt))
      .limit(1);

    const snapshotTurn = snapshot?.turnNumber ?? null;
    if (snapshot) {
      const payload = (snapshot.state ?? {}) as SnapshotPayload;
      for (const [entityId, state] of Object.entries(payload.entities ?? {})) {
        await tx
          .update(entities)
          .set({ state })
          .where(and(eq(entities.id, entityId), eq(entities.campaignId, campaignId)));
      }
    }

    // Replay G1 forward: re-apply resource spends for every surviving turn
    // after the snapshot up to N, onto the player-character entity. Floor at 0
    // per spend — mirrors a forward mechanical write. These turns are ≤ N and
    // so survive the spine delete below; reading them first is not required,
    // but keeps the replay independent of delete ordering.
    const replayRows = await tx
      .select({ conte: turns.conte })
      .from(turns)
      .where(
        and(
          eq(turns.campaignId, campaignId),
          gt(turns.turnNumber, snapshotTurn ?? 0),
          lte(turns.turnNumber, toTurn),
        ),
      )
      .orderBy(asc(turns.turnNumber));

    const [pc] = await tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.campaignId, campaignId),
          eq(entities.entityType, "player"),
          notTombstoned(entities),
        ),
      )
      .limit(1);

    if (pc) {
      const state = (pc.state as EntityState | null) ?? {};
      const resources: Record<string, ResourcePool> = { ...(state.resources ?? {}) };
      for (const row of replayRows) {
        const conte = row.conte as { mechanics?: { resource_spends?: ResourceSpend[] } } | null;
        for (const spend of conte?.mechanics?.resource_spends ?? []) {
          const key = spend.resource.toUpperCase();
          const pool = resources[key];
          if (pool) {
            resources[key] = {
              ...pool,
              current: Math.max(0, pool.current - spend.amount),
            };
          } else {
            // Mirror forward-G1 exactly: an unknown resource initializes at
            // a default max of 100, floored at 0 (C6 audit — divergent
            // replay math would drift the restored state).
            resources[key] = { current: Math.max(0, 100 - spend.amount), max: 100 };
          }
        }
      }
      await tx
        .update(entities)
        .set({ state: { ...state, resources } })
        .where(eq(entities.id, pc.id));
    }

    // 4. Delete the dead-timeline spine turns (§6.7: the tombstoned episodic
    //    rows carry the provenance record; the turns rows need not linger).
    await tx
      .delete(turns)
      .where(and(eq(turns.campaignId, campaignId), gt(turns.turnNumber, toTurn)));

    // 5. Log the rewind (§6.7 event log).
    await tx.insert(rewinds).values({
      campaignId,
      rewoundToTurn: toTurn,
      tombstonedCount,
      reason: reason ?? null,
    });

    // External side effects are explicitly non-reversible and flagged (§6.7).
    // Generated media joins this list when the media pipeline lands (§9.5).
    return { tombstonedCount, snapshotTurn, nonReversible: ["model spend"] };
  });
}

/**
 * Snapshot mechanical state every 5th turn (§6.7 — carried from v3): capture
 * all catalog entities' `state` under the { entities: { <id>: state } } payload.
 * Idempotent under the durable-turn re-entrancy (§5.7/§5.8): one snapshot per
 * turn number, so a G1 crash-replay overwrites rather than duplicates.
 */
export async function writeSnapshotIfDue(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<void> {
  if (turnNumber <= 0 || turnNumber % 5 !== 0) return;

  const catalog = await db
    .select({ id: entities.id, state: entities.state })
    .from(entities)
    .where(and(eq(entities.campaignId, campaignId), notTombstoned(entities)));

  const payload: SnapshotPayload = {
    entities: Object.fromEntries(catalog.map((e) => [e.id, (e.state as EntityState | null) ?? {}])),
  };

  await db.transaction(async (tx) => {
    await tx
      .delete(stateSnapshots)
      .where(
        and(eq(stateSnapshots.campaignId, campaignId), eq(stateSnapshots.turnNumber, turnNumber)),
      );
    await tx.insert(stateSnapshots).values({ campaignId, turnNumber, state: payload });
  });
}
