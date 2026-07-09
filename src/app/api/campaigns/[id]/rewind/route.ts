import { getCurrentUser } from "@/lib/auth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { getDb } from "@/lib/db";
import { campaigns, turns } from "@/lib/db/schema";
import { OPEN_TURN_STATUSES, checkRewindGuards, rewindCampaign } from "@/lib/turn/rewind";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rewind the campaign (§6.7): tombstone layer writes past toTurn, restore
 * mechanical state, log the event. Bounded to the play view's ≤10-turn window;
 * rejected (409) while a turn is in flight. Non-reversible external effects
 * (model spend; media later) are flagged in the response.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (campaign.status !== "active") {
    return NextResponse.json({ error: "campaign is not active" }, { status: 409 });
  }

  const { toTurn, reason } = (await req.json().catch(() => ({}))) as {
    toTurn?: number;
    reason?: string;
  };
  if (typeof toTurn !== "number") {
    return NextResponse.json({ error: "toTurn required" }, { status: 400 });
  }

  const [last] = await db
    .select({ n: turns.turnNumber })
    .from(turns)
    .where(eq(turns.campaignId, id))
    .orderBy(desc(turns.turnNumber))
    .limit(1);
  const currentMax = last?.n ?? 0;

  const [open] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, id), inArray(turns.status, [...OPEN_TURN_STATUSES])))
    .limit(1);

  const guard = checkRewindGuards({ toTurn, currentMax, hasOpenTurn: Boolean(open) });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // Drain lagging/in-flight G2 settles before the sweep (rewindCampaign's
  // caller contract): a detached settle racing the tombstone pass would
  // write ghost rows for an un-happened turn. The promise-map guard makes
  // this await in-flight work, not just skip it.
  await settleG2IfPending(db, id);

  const result = await rewindCampaign(db, id, toTurn, reason);
  return NextResponse.json(result);
}
