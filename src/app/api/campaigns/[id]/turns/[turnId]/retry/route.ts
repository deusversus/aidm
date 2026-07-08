import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, turns } from "@/lib/db/schema";
import { executeTurn, isRunning } from "@/lib/turn/runtime";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retry a failed turn (§5.7): re-enters the executor at the last completed
 * checkpoint — the conte is reused, so the dice stay as they fell.
 * Mechanics are never re-judged.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id, turnId } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [turn] = await db
    .select()
    .from(turns)
    .where(and(eq(turns.id, turnId), eq(turns.campaignId, id)));
  if (!turn) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (turn.status !== "failed") {
    return NextResponse.json({ error: "turn is not in a failed state" }, { status: 409 });
  }
  if (isRunning(turnId)) {
    return NextResponse.json({ error: "turn is already running" }, { status: 409 });
  }

  // Reopen: move OFF the terminal 'failed' status so the executor runs, then
  // let its per-step CHECKPOINT markers (not this status) decide where to
  // resume — Phase A re-rolls if it never checkpointed; otherwise it skips
  // to the last incomplete step. One source of truth, no status guessing.
  await db.update(turns).set({ status: "queued" }).where(eq(turns.id, turnId));
  void executeTurn(db, turnId).catch((err) => {
    console.error("[retry] execution crashed", { turnId, err });
  });
  return NextResponse.json({ ok: true, turnId });
}
