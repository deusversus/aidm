import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, entities, turns } from "@/lib/db/schema";
import { mergeEntities } from "@/lib/entity/merge";
import { DirectionState, type MergeSuggestion } from "@/lib/types/direction";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Booth-surfaced merge suggestions (§6.5, M2 C1): the janitor's ambiguous
 * near-duplicate pairs, resolved by player word only. GET lists the pending
 * suggestions; POST accepts one (invokes the frozen merge primitive with
 * provenance merge:player); DELETE dismisses one (drops it from
 * direction_state without merging). The route only executes janitor-proposed
 * merges — free-form player merges are out of scope for M2.
 */

/** A proposed pair as it matches the stored suggestion, either orientation. */
const pairMatches = (s: MergeSuggestion, survivorId: string, dupeId: string): boolean =>
  (s.survivor_id === survivorId && s.dupe_id === dupeId) ||
  (s.survivor_id === dupeId && s.dupe_id === survivorId);

/** List the campaign's pending merge suggestions (§6.5 janitor output). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const state = DirectionState.parse(campaign.directionState ?? {});
  // Display self-heal (C1 audit #1/#6): a suggestion resurrected by a
  // concurrent whole-state save can reference tombstoned rows — never show it.
  const ids = [...new Set(state.merge_suggestions.flatMap((s) => [s.survivor_id, s.dupe_id]))];
  const rows =
    ids.length > 0
      ? await db
          .select({ id: entities.id, tombstonedAt: entities.tombstonedAt })
          .from(entities)
          .where(inArray(entities.id, ids))
      : [];
  const dead = new Set(rows.filter((r) => r.tombstonedAt).map((r) => r.id));
  const suggestions = state.merge_suggestions.filter(
    (s) => !dead.has(s.survivor_id) && !dead.has(s.dupe_id),
  );
  return NextResponse.json({ suggestions });
}

/** Accept a suggestion: merge the pair (merge:player). The primitive itself
 *  tombstones the dupe and clears the suggestion from direction_state. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { survivor_id, dupe_id } = (await req.json().catch(() => ({}))) as {
    survivor_id?: string;
    dupe_id?: string;
  };
  if (!survivor_id || !dupe_id) {
    return NextResponse.json({ error: "survivor_id and dupe_id required" }, { status: 400 });
  }

  const state = DirectionState.parse(campaign.directionState ?? {});
  const stored = state.merge_suggestions.find((s) => pairMatches(s, survivor_id, dupe_id));
  if (!stored) {
    return NextResponse.json({ error: "no such merge suggestion" }, { status: 400 });
  }

  // Anchor the merge to the campaign's latest turn (player: current turn).
  const [last] = await db
    .select({ n: turns.turnNumber })
    .from(turns)
    .where(eq(turns.campaignId, id))
    .orderBy(desc(turns.turnNumber))
    .limit(1);

  // The STORED suggestion's orientation executes (C1 audit #5) — the caller
  // only identifies the pair; a reversed body must not flip survivor/dupe.
  const result = await mergeEntities(db, {
    campaignId: id,
    survivorId: stored.survivor_id,
    dupeId: stored.dupe_id,
    provenance: "merge:player",
    turnId: last?.n ?? 0,
  });
  return NextResponse.json({ ok: true, ...result });
}

/** Dismiss a suggestion: drop it from direction_state, no merge (player word
 *  declines the pair). Mirrors the engine's direction-state write. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { survivor_id, dupe_id } = (await req.json().catch(() => ({}))) as {
    survivor_id?: string;
    dupe_id?: string;
  };
  if (!survivor_id || !dupe_id) {
    return NextResponse.json({ error: "survivor_id and dupe_id required" }, { status: 400 });
  }

  // Read-modify-write under a row lock (C1 audit #1) so a concurrent janitor
  // append or merge cleanup can't be clobbered by this dismiss.
  const found = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${campaigns} WHERE ${campaigns.id} = ${id} FOR UPDATE`);
    const [row] = await tx
      .select({ directionState: campaigns.directionState })
      .from(campaigns)
      .where(eq(campaigns.id, id));
    const state = DirectionState.parse(row?.directionState ?? {});
    if (!state.merge_suggestions.some((s) => pairMatches(s, survivor_id, dupe_id))) return false;
    const next: DirectionState = {
      ...state,
      merge_suggestions: state.merge_suggestions.filter(
        (s) => !pairMatches(s, survivor_id, dupe_id),
      ),
    };
    await tx
      .update(campaigns)
      .set({ directionState: next, updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    return true;
  });
  if (!found) {
    return NextResponse.json({ error: "no such merge suggestion" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
