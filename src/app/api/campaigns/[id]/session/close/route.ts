import { getCurrentUser } from "@/lib/auth";
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
 * engine-internal. Returns the yokoku (next-episode tease) when composed.
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

  const result = await closeSession(db, id, "explicit");
  return NextResponse.json(result);
}
