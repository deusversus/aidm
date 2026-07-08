import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { TurnInProgressError, submitTurn } from "@/lib/turn/runtime";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enqueue a turn (§5.7). Returns immediately; progress streams via /stream. */
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
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) {
    return NextResponse.json({ error: "empty input" }, { status: 400 });
  }

  try {
    const result = await submitTurn(db, id, message.trim());
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TurnInProgressError) {
      // §5.7: queued input never errors the player — the client holds it
      // with a visible pending state and resubmits when the turn lands.
      return NextResponse.json({ pending: err.pendingTurnId }, { status: 409 });
    }
    throw err;
  }
}
