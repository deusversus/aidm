import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShelfAction = "archive" | "unarchive" | "delete";

/**
 * The campaign shelf's write path (§9.1): archive / unarchive / soft-delete.
 * Deleting is a status flip to "deleted", never a row DELETE — the campaign
 * and its nine layers survive for provenance and possible restoration. The
 * play/SZ guards already lock out non-active/non-draft status, so a shelved
 * campaign is naturally unreachable. Invalid transitions 409; unknown actions
 * 400.
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

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== "archive" && action !== "unarchive" && action !== "delete") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  const next = nextStatus(campaign.status, action);
  if (!next) {
    return NextResponse.json(
      { error: `cannot ${action} a ${campaign.status} campaign` },
      { status: 409 },
    );
  }

  await db
    .update(campaigns)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(campaigns.id, id));
  return NextResponse.json({ ok: true, status: next });
}

/**
 * Legal shelf transitions (§9.1). Soft delete is a status, not a row delete —
 * and deleting a draft is allowed (an abandoned Session Zero). A "compiling"
 * campaign is mid-flight and has no shelf transition.
 */
function nextStatus(current: string, action: ShelfAction): string | null {
  if (action === "archive") return current === "active" ? "archived" : null;
  if (action === "unarchive") return current === "archived" ? "active" : null;
  // delete
  if (current === "active" || current === "archived" || current === "draft") return "deleted";
  return null;
}
