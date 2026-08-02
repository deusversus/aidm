import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, turns } from "@/lib/db/schema";
import { answerEvolution } from "@/lib/direction/evolution";
import { rebuildSettei } from "@/lib/direction/session";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The §7.1 season-boundary ratification card's two answers (M3 C4). The play
 * PAGE reads the pending proposal server-side from direction_state — no GET
 * here. There is no DELETE and no dismiss: a proposal is a QUESTION, and
 * silence must never amend the premise. It persists across mounts until the
 * player says one of two words.
 *
 * RATIFY amends the ACTIVE premise layer permanently and dates a note into the
 * bible; PULL HOME plants retakes so the drift band pulls the prose back to the
 * premise the player kept. Both clear the proposal.
 */

const Answer = z.object({ action: z.enum(["ratify", "pull_home"]) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db
    .select({ playerId: campaigns.playerId })
    .from(campaigns)
    .where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = Answer.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "action must be ratify or pull_home" }, { status: 400 });
  }

  const result = await answerEvolution(db, id, body.data.action);
  if (!result.ok) {
    if (result.reason === "contract_unreadable") {
      // Loudly, never a silent 200 — the card stays up rather than lie.
      return NextResponse.json(
        { error: "premise contract unreadable — cannot amend" },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: "no evolution proposal pending" }, { status: 409 });
  }

  // §4.4a regeneration trigger (2): "the player edits the active premise". A
  // ratification IS that edit, so the frozen Settei must be re-rendered or
  // Block 1 would keep pressing the premise the player just retired until the
  // next session open. Pure code (no model call); best-effort — the amendment
  // is already durable, and the next open rebuilds regardless.
  if (body.data.action === "ratify") {
    try {
      const [latest] = await db
        .select({ turnNumber: turns.turnNumber })
        .from(turns)
        .where(eq(turns.campaignId, id))
        .orderBy(desc(turns.turnNumber))
        .limit(1);
      await rebuildSettei(db, id, latest?.turnNumber ?? 0);
    } catch (err) {
      console.warn("[evolution] Settei rebuild after ratification failed (non-fatal)", {
        campaignId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, action: body.data.action, axes: result.axes });
}
