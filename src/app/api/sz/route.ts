import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, players } from "@/lib/db/schema";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Begin Session Zero: a draft campaign the conductor conversation lives on. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const db = getDb();
  // Dev safety net: the Clerk webhook provisions players in prod; a local
  // session may predate it. Idempotent either way.
  await db
    .insert(players)
    .values({ id: user.id, email: user.email ?? "" })
    .onConflictDoNothing();

  const [campaign] = await db
    .insert(campaigns)
    .values({ playerId: user.id, title: "Session Zero", status: "draft" })
    .returning();
  if (!campaign) return NextResponse.json({ error: "create failed" }, { status: 500 });
  return NextResponse.json({ campaignId: campaign.id });
}
