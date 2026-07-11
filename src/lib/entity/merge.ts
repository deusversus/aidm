import type { Db } from "@/lib/db";
import { campaigns, entities, entityVersions } from "@/lib/db/schema";
import { DirectionState } from "@/lib/types/direction";
import { eq, sql } from "drizzle-orm";

/**
 * The merge primitive (§6.5, M2 C1): the same operation the 2026-07-10 manual
 * repair performed by hand, as a system action. Survivor keeps the row and
 * absorbs the dupe's material; the dupe tombstones. Reversible by
 * construction — nothing is deleted, and the survivor's prior block survives
 * in entity_versions.
 *
 * Block merge order carries the compiler's dedup discipline: identity
 * material first, capability material after. State folds conservatively:
 * spotlightDebt takes the max, relationships union (survivor precedence on
 * key collision), interiority events sum.
 */

export type MergeProvenance = "merge:janitor" | "merge:player";

export interface MergeResult {
  survivorId: string;
  dupeId: string;
  /** The survivor's block after the merge (also written to its version row). */
  mergedBlock: string;
  versionWritten: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Fold the dupe's structured state into the survivor's (§7.5): survivor
 * precedence on any unknown key, spotlightDebt = max, relationships = union
 * (survivor wins per key), interiorityEvents = sum only when both are numeric.
 */
function foldState(
  survivor: Record<string, unknown>,
  dupe: Record<string, unknown>,
): Record<string, unknown> {
  // Survivor precedence baseline: dupe-only keys carry over, collisions keep survivor.
  const merged: Record<string, unknown> = { ...dupe, ...survivor };

  if (survivor.spotlightDebt !== undefined || dupe.spotlightDebt !== undefined) {
    merged.spotlightDebt = Math.max(numOr(survivor.spotlightDebt, 0), numOr(dupe.spotlightDebt, 0));
  }

  if (survivor.relationships !== undefined || dupe.relationships !== undefined) {
    merged.relationships = { ...asRecord(dupe.relationships), ...asRecord(survivor.relationships) };
  }

  if (
    typeof survivor.interiorityEvents === "number" &&
    typeof dupe.interiorityEvents === "number"
  ) {
    merged.interiorityEvents = survivor.interiorityEvents + dupe.interiorityEvents;
  }

  return merged;
}

/**
 * Append the dupe's block onto the survivor's, skipping any line already
 * present verbatim in the survivor (identity-before-capability spirit: the
 * survivor's material stays first, the dupe's new material appends after).
 */
function mergeBlocks(survivorBlock: string, dupeBlock: string): string {
  const present = new Set(
    survivorBlock
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  const addition = dupeBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !present.has(l));
  if (addition.length === 0) return survivorBlock;
  return survivorBlock.trim().length > 0
    ? `${survivorBlock}\n${addition.join("\n")}`
    : addition.join("\n");
}

export async function mergeEntities(
  db: Db,
  args: {
    campaignId: string;
    survivorId: string;
    dupeId: string;
    provenance: MergeProvenance;
    /** The turn this merge is anchored to (janitor: session-close turn; player: current turn). */
    turnId: number;
  },
): Promise<MergeResult> {
  return db.transaction(async (tx) => {
    // Serialize suggestion writers on the campaign row (C1 audit #1): the
    // janitor's append, the route's dismiss, and this cleanup all
    // read-modify-write direction_state.
    await tx.execute(
      sql`SELECT id FROM ${campaigns} WHERE ${campaigns.id} = ${args.campaignId} FOR UPDATE`,
    );
    const [survivor] = await tx.select().from(entities).where(eq(entities.id, args.survivorId));
    const [dupe] = await tx.select().from(entities).where(eq(entities.id, args.dupeId));
    if (!survivor) throw new Error(`mergeEntities: survivor ${args.survivorId} not found`);
    if (!dupe) throw new Error(`mergeEntities: dupe ${args.dupeId} not found`);
    if (survivor.id === dupe.id)
      throw new Error("mergeEntities: survivor and dupe are the same row");
    if (survivor.campaignId !== args.campaignId || dupe.campaignId !== args.campaignId) {
      throw new Error("mergeEntities: entity does not belong to the campaign");
    }
    // A stale suggestion (e.g. resurrected by a concurrent whole-state save)
    // must never re-merge dead rows (C1 audit #6).
    if (survivor.tombstonedAt || dupe.tombstonedAt) {
      throw new Error("mergeEntities: refusing to merge a tombstoned entity");
    }

    const mergedBlock = mergeBlocks(survivor.block, dupe.block);
    const mergedState = foldState(asRecord(survivor.state), asRecord(dupe.state));

    const [{ maxVersion } = { maxVersion: null }] = await tx
      .select({ maxVersion: sql<number | null>`max(${entityVersions.version})` })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, args.survivorId));
    const version = (maxVersion ? Number(maxVersion) : 0) + 1;
    const envelope = { turnId: args.turnId, provenance: args.provenance, confidence: 1 } as const;

    // Tombstone the dupe (never delete — reversibility is the whole point, §6.7).
    await tx.update(entities).set({ tombstonedAt: new Date() }).where(eq(entities.id, args.dupeId));

    // Enrich the survivor: new block + folded state, and a version row records it.
    await tx
      .update(entities)
      .set({ block: mergedBlock, state: mergedState })
      .where(eq(entities.id, args.survivorId));
    await tx
      .insert(entityVersions)
      .values({ entityId: args.survivorId, version, block: mergedBlock, ...envelope });

    // A merged/tombstoned pair must not linger as a booth suggestion: drop any
    // merge_suggestion referencing either id. Inlined (not via director's
    // load/save) to keep merge.ts off the ingest→janitor→director import cycle.
    const [campaignRow] = await tx
      .select({ directionState: campaigns.directionState })
      .from(campaigns)
      .where(eq(campaigns.id, args.campaignId));
    const state = DirectionState.parse(campaignRow?.directionState ?? {});
    const involved = new Set([args.survivorId, args.dupeId]);
    const remaining = state.merge_suggestions.filter(
      (s) => !involved.has(s.survivor_id) && !involved.has(s.dupe_id),
    );
    if (remaining.length !== state.merge_suggestions.length) {
      await tx
        .update(campaigns)
        .set({ directionState: { ...state, merge_suggestions: remaining }, updatedAt: new Date() })
        .where(eq(campaigns.id, args.campaignId));
    }

    return {
      survivorId: args.survivorId,
      dupeId: args.dupeId,
      mergedBlock,
      versionWritten: version,
    };
  });
}
