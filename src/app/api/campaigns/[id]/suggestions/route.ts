import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, episodicRecords, turns } from "@/lib/db/schema";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { OPEN_TURN_STATUSES } from "@/lib/turn/rewind";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SuggestionMoves = z.object({ moves: z.array(z.string()).min(2).max(3) });

/**
 * On-demand suggestions (§9.2's second half): a player-summonable probe that
 * offers 2-3 premise-true next moves off the last scene's tail. Serves both
 * default_on and on_request_only affordances; the client hides the summon for
 * "never". Rejected (409) while a turn is in flight — no suggestions for a
 * scene that hasn't landed.
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
  if (campaign.status !== "active") {
    return NextResponse.json({ error: "campaign is not active" }, { status: 409 });
  }

  // A turn in flight owns the scene; suggestions wait for it to land (§5.7).
  const [open] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, id), inArray(turns.status, [...OPEN_TURN_STATUSES])))
    .limit(1);
  if (open) return NextResponse.json({ error: "a turn is in progress" }, { status: 409 });

  // Seed off the last live scene's tail (tombstoned/rewound turns excluded).
  const [lastScene] = await db
    .select({ narration: episodicRecords.narration, turnNumber: episodicRecords.turnNumber })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, id), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(1);
  const tail = (lastScene?.narration ?? "").slice(-600);

  const parsed = TierSelection.safeParse(campaign.tierModels);
  const selection = parsed.success ? parsed.data : DEV_TIER_SELECTION;

  const { moves } = await callProbe(selection, {
    name: "suggestions_summon",
    schema: SuggestionMoves,
    prompt: `${tail}\n\noffer 2-3 concrete, premise-true next moves the player could take — short imperative phrases, no numbering`,
    campaignId: id,
    turnNumber: lastScene?.turnNumber,
  });
  return NextResponse.json({ moves });
}
