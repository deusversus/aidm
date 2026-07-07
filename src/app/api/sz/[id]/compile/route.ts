import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { compileSessionZero } from "@/lib/sz/compiler";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The §8 handoff: compile the SZ draft into PremiseContract +
 * OpeningStatePackage. Blocking gaps return 409 with the list — the
 * conversation resumes; nothing is persisted.
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
  if (campaign.status !== "draft") {
    return NextResponse.json({ error: "already compiled" }, { status: 409 });
  }

  try {
    const result = await compileSessionZero(db, id);
    if (result.gaps.length > 0) {
      return NextResponse.json({ ok: false, gaps: result.gaps }, { status: 409 });
    }
    return NextResponse.json({ ok: true, spark: result.contract.spark });
  } catch (err) {
    console.error("[sz/compile] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "compile failed" },
      { status: 500 },
    );
  }
}
