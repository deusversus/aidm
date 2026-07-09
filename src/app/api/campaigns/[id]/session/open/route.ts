import { getCurrentUser } from "@/lib/auth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { openSession } from "@/lib/direction/session";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open a play sitting (§9.4). Idempotent — the play view calls this on every
 * mount; a fresh open session returns { opened: false } and does nothing.
 * Runs the full open sequence (idle-close → Director → Settei rebuild →
 * pre-warm → recap) on a genuine open.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  // openSession's caller contract: drain lagging G2 before the Settei
  // rebuild reads the marks it would otherwise orphan (§5.8's
  // catch-up-before-reader; same pattern as the rewind route).
  await settleG2IfPending(db, id);

  const result = await openSession(db, id);
  return NextResponse.json(result);
}
