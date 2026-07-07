import { getCurrentUser } from "@/lib/auth";
import { assembleForCampaign } from "@/lib/blocks/campaign";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { prewarmPrefix } from "@/lib/llm/calls";
import { TierSelection } from "@/lib/llm/tiers";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cache pre-warm (§5.6): fired by the play view when the input regains
 * focus after idle. Server side of the seam; the client hook lands with
 * the M1 play view.
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
  const selection = TierSelection.safeParse(campaign.tierModels);
  if (!selection.success) {
    return NextResponse.json({ error: "campaign has no tier selection yet" }, { status: 409 });
  }
  const blocks = await assembleForCampaign(db, id);
  if (!blocks) {
    return NextResponse.json({ error: "campaign has no premise contract yet" }, { status: 409 });
  }

  const result = await prewarmPrefix(selection.data, blocks.system, { campaignId: id });
  return NextResponse.json({ ...result, budgets: blocks.budgets });
}
