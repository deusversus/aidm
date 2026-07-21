import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The §4.5 M2R3 steering-honesty notice (the play surface's one quiet line).
 * The play PAGE reads the flag server-side from direction_state — no GET here.
 * DELETE dismisses it: silence is consent, and dismiss clears it so it never
 * shows twice (once per override). Atomic single-key jsonb removal - no full
 * DirectionState parse, no lock needed to delete one key. Known narrow race
 * (audited, accepted): a Director cycle that loaded state BEFORE this
 * dismiss re-persists the old notice on its whole-object save; it shows
 * once more and the next dismiss sticks - self-healing.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Atomic jsonb key removal — no full-state parse (browser-verified live,
  // 2026-07-21: a malformed notice 500'd the dismiss when the route parsed
  // the WHOLE DirectionState just to delete one key). Removing a key needs
  // no understanding of its siblings, and the single-statement update can't
  // clobber a concurrent Director save's other fields.
  await db
    .update(campaigns)
    .set({
      directionState: sql`coalesce(${campaigns.directionState}, '{}'::jsonb) #- '{steering_notice}'`,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, id));

  return NextResponse.json({ ok: true });
}
