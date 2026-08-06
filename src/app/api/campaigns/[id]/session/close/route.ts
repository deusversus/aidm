import { getCurrentUser } from "@/lib/auth";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { closeSession } from "@/lib/direction/session";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Close the current play sitting (§9.4). Only the "explicit" trigger is
 * accepted from the client — idle_timeout and rolling_checkpoint are
 * engine-internal. Returns the yokoku (next-episode tease) and, where the
 * premise granted one, the stinger (§8's post-credits beat) when composed.
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

  const { trigger } = (await req.json().catch(() => ({}))) as { trigger?: string };
  if ((trigger ?? "explicit") !== "explicit") {
    return NextResponse.json({ error: "only an explicit close is accepted" }, { status: 400 });
  }

  // §5.8 catch-up-before-reader, at the CLOSE boundary too (M3R2 C5). Every
  // close artifact is a reader of what G2 writes: the memo reads narrated
  // fragments, seed state and spotlight debt; the voice journal reads the
  // session's narration; the Sakkan samples the record; the janitor reads the
  // catalog. The open and rewind routes have always drained first — the close
  // did not, so a sitting ended while the last turn's G2 lagged composed the
  // whole Learned layer from a half-written record and then froze it. The
  // drain lives here, not in closeSession, because direction/session cannot
  // import compositor/g2 (g2 imports rollingCheckpoint from it — a cycle).
  await settleG2IfPending(db, id);

  const result = await closeSession(db, id, "explicit");
  return NextResponse.json(result);
}
