import { getBudgetSnapshot } from "@/lib/budget";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/budget — current-user budget snapshot (Commit 9).
 *
 * Returns the shape the <BudgetIndicator /> component renders:
 *   - capUsd: user's self-set daily cap, or null when no cap is set
 *   - usedUsd: today's cumulative spend in UTC
 *   - percent: usedUsd / capUsd (null when cap is null or 0)
 *   - warn50, warn90: boolean flags crossing the two warn thresholds
 *   - rateCount + rateCap: current-minute turn count vs. system cap
 *   - nextResetAt: ISO timestamp of the next UTC midnight
 *
 * Authorizes on the Clerk session — users can only read their own
 * snapshot. No campaign scoping; budget is a user-level concept.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) {
    console.warn("[budget] 401 unauthenticated");
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const snapshot = await getBudgetSnapshot(user.id);
    return NextResponse.json(snapshot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[budget] 500 snapshot failed", { userId: user.id, detail });
    return NextResponse.json({ error: "snapshot_failed", detail }, { status: 500 });
  }
}
