import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { consequences, entities } from "@/lib/db/schema";
import { ingestAssertion } from "@/lib/ingestion/ingest";
import { writeSnapshotIfDue } from "@/lib/turn/rewind";
import type { Conte } from "@/lib/types/conte";
import type { CommitScene } from "@/lib/types/sidecar";
import { and, eq, sql } from "drizzle-orm";

/**
 * Chronicler Group 1 — the must-commit write group (blueprint §5.8). Runs
 * synchronously inside the turn executor, AFTER the verbatim episodic write
 * and BEFORE the done event, so the next turn's Phase A reads a settled
 * world: mechanical state applied, consequences live, cast catalog current.
 *
 * The episodic verbatim record and the turn checkpoint markers are C5's
 * G1-minimal slice (in the runtime). This module owns the rest of Group 1:
 * mechanical-state application, consequence application, cast-catalog changes
 * from the sidecar, the player-assertion ingestion seam, and the mechanical-
 * state snapshot. Every step is INDIVIDUALLY idempotent — G1 re-runs on a
 * crash between the episodic insert and the g1 checkpoint marker, so a second
 * application must be a no-op.
 */

const G1_PROVENANCE = "chronicler_g1";

interface ResourceState {
  current: number;
  max: number;
}
interface PlayerState {
  resources?: Record<string, ResourceState>;
  /** Per-turn idempotency guard: the highest turn whose spends are applied. */
  lastAppliedTurn?: number;
  notes?: string[];
  [key: string]: unknown;
}

export async function settleG1(
  db: Db,
  args: {
    campaignId: string;
    turnId: string;
    turnNumber: number;
    conte: Conte;
    sidecar: CommitScene | null;
    profileIds: string[];
  },
): Promise<void> {
  const { campaignId, turnNumber, conte, sidecar, profileIds } = args;

  await applyMechanicalState(db, campaignId, turnNumber, conte);
  await applyConsequence(db, campaignId, turnNumber, conte);
  await applyCastCatalog(db, campaignId, turnNumber, sidecar);
  await applyWorldAssertions(db, campaignId, turnNumber, conte, profileIds);

  // Override/pin updates: none arrive via the M1 commit_scene sidecar (§5.7's
  // field list carries no override/pin delta). When the meta booth (C9) or a
  // future sidecar field mints one, apply it HERE — before the snapshot, so a
  // rewind's forward-replay of G1 restores it. Stated seam, intentionally empty.

  // The mechanical-state snapshot rides last: it must capture the state AFTER
  // this turn's spends/consequences so rewind restores the nearest ≤ N and
  // replays G1 forward (§6.7). Owned by src/lib/turn/rewind.ts.
  await writeSnapshotIfDue(db, campaignId, turnNumber);
}

/**
 * Apply `conte.mechanics.resource_spends` to the player-character entity.
 * Idempotent per turn via `state.lastAppliedTurn`. Campaigns may predate a PC
 * sheet — if there's no player entity we skip gracefully (whole shape, thin).
 */
async function applyMechanicalState(
  db: Db,
  campaignId: string,
  turnNumber: number,
  conte: Conte,
): Promise<void> {
  const spends = conte.mechanics?.resource_spends ?? [];
  if (spends.length === 0) return;

  const [pc] = await db
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
  if (!pc) return; // no PC sheet yet — nothing to charge

  const state = (pc.state ?? {}) as PlayerState;
  if ((state.lastAppliedTurn ?? -1) >= turnNumber) return; // already applied this turn

  const resources: Record<string, ResourceState> = { ...(state.resources ?? {}) };
  const notes: string[] = [...(state.notes ?? [])];
  for (const spend of spends) {
    const key = spend.resource.toUpperCase();
    const existing = resources[key];
    if (existing) {
      resources[key] = {
        current: Math.max(0, existing.current - spend.amount),
        max: existing.max,
      };
    } else {
      // Unknown resource: initialize at a default max of 100, floored at 0.
      resources[key] = { current: Math.max(0, 100 - spend.amount), max: 100 };
      notes.push(`t${turnNumber}: initialized ${key} at default max 100 (no sheet value)`);
    }
  }

  const nextState: PlayerState = { ...state, resources, notes, lastAppliedTurn: turnNumber };
  await db.update(entities).set({ state: nextState }).where(eq(entities.id, pc.id));
}

/**
 * A judged consequence (§7.5 — the world remembers) becomes a live
 * consequences row. Idempotent via a pre-check on (campaign, turnId,
 * provenance): a G1 replay finds its own row and skips.
 */
async function applyConsequence(
  db: Db,
  campaignId: string,
  turnNumber: number,
  conte: Conte,
): Promise<void> {
  const text = conte.outcome?.consequence?.trim();
  if (!text) return;

  const [existing] = await db
    .select({ id: consequences.id })
    .from(consequences)
    .where(
      and(
        eq(consequences.campaignId, campaignId),
        eq(consequences.turnId, turnNumber),
        eq(consequences.provenance, G1_PROVENANCE),
        notTombstoned(consequences),
      ),
    )
    .limit(1);
  if (existing) return;

  await db.insert(consequences).values({
    campaignId,
    description: text,
    active: true,
    turnId: turnNumber,
    provenance: G1_PROVENANCE,
    confidence: 0.9,
  });
}

/**
 * Cast-catalog changes from the sidecar (§6.5 — admission is an explicit act):
 * `admit_to_catalog` mints a catalog entity (or enriches an existing same-name
 * one); `dismiss` marks it dismissed; `spawn_transient` persists NOTHING —
 * transients expire with the scene. Background extraction never creates
 * entities (that guard lives in G2); only these three authorities do.
 */
async function applyCastCatalog(
  db: Db,
  campaignId: string,
  turnNumber: number,
  sidecar: CommitScene | null,
): Promise<void> {
  const deltas = sidecar?.scene_cast_delta ?? [];
  for (const delta of deltas) {
    if (delta.action === "spawn_transient") continue;

    const [existing] = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.campaignId, campaignId),
          sql`lower(${entities.name}) = ${delta.name.toLowerCase()}`,
          notTombstoned(entities),
        ),
      )
      .limit(1);

    if (delta.action === "dismiss") {
      if (existing && existing.status === "active") {
        await db.update(entities).set({ status: "dismissed" }).where(eq(entities.id, existing.id));
      }
      continue;
    }

    // admit_to_catalog
    const note = delta.note ?? "";
    if (existing) {
      // Same-name entity already catalogued: enrich its block with the note
      // rather than minting a duplicate. Idempotent — a G1 replay finds the
      // note already present and skips the append.
      if (note && !existing.block.includes(note)) {
        const block = existing.block ? `${existing.block}\n${note}` : note;
        await db.update(entities).set({ block }).where(eq(entities.id, existing.id));
      }
      continue;
    }

    await db
      .insert(entities)
      .values({
        campaignId,
        name: delta.name,
        entityType: "npc",
        block: note,
        turnId: turnNumber,
        provenance: G1_PROVENANCE,
        confidence: 0.9,
      })
      // The partial unique index (campaign, type, name) WHERE not tombstoned
      // makes a concurrent/replayed admit a no-op.
      .onConflictDoNothing();
  }
}

/**
 * Player-authored world-building (§5.4/§6.5, highest catalog authority) routes
 * through the universal ingestion subsystem — resolve against canon + campaign
 * state, then write with provenance. In M1 normal play `world_assertion_notes`
 * is empty (Layout leaves the channel dormant), so this is a wired-but-quiet
 * seam (axiom 8: whole shape from day one). Best-effort: an ingestion failure
 * must never wedge the must-commit group.
 */
async function applyWorldAssertions(
  db: Db,
  campaignId: string,
  turnNumber: number,
  conte: Conte,
  profileIds: string[],
): Promise<void> {
  for (const note of conte.world_assertion_notes ?? []) {
    const text = note.trim();
    if (!text) continue;
    try {
      await ingestAssertion(db, campaignId, turnNumber, text, {
        profileIds,
        provenance: "player_assertion",
      });
    } catch (err) {
      console.error("[g1] world-assertion ingestion failed — canon not persisted this turn", {
        campaignId,
        turnNumber,
        err,
      });
    }
  }
}
