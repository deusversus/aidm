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
 * On-demand suggestions (§9.2's second half): a player-summonable call that
 * offers 2-3 premise-true next moves. The latest scene's PERSISTED sidecar
 * moves are served first when they exist (the KA wrote them with full scene
 * context — fresher and free); the probe off the narration tail is the
 * fallback. Serves default_on and on_request_only; "never" is honored
 * server-side (M2R R1 — one client-side button-hide is not a boundary).
 * Rejected (409) while a turn is in flight — no suggestions for a scene
 * that hasn't landed.
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
  const contract = campaign.premiseContract as { suggestion_affordance?: string } | null;
  if (contract?.suggestion_affordance === "never") {
    return NextResponse.json({ error: "suggestions are off for this campaign" }, { status: 403 });
  }

  // A turn in flight owns the scene; suggestions wait for it to land (§5.7).
  const [open] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, id), inArray(turns.status, [...OPEN_TURN_STATUSES])))
    .limit(1);
  if (open) return NextResponse.json({ error: "a turn is in progress" }, { status: 409 });

  // The KA's own persisted moves for the latest scene, when it wrote them —
  // full-context and already paid for. decision_point is NOT required here:
  // an explicit summon is player word, and ~24% of move-carrying sidecars
  // flag no decision point (audit 2026-07-19).
  const [lastTurn] = await db
    .select({ sidecar: turns.sidecar })
    .from(turns)
    .where(and(eq(turns.campaignId, id), eq(turns.status, "complete")))
    .orderBy(desc(turns.turnNumber))
    .limit(1);
  const persisted = (lastTurn?.sidecar as { suggested_moves?: string[] } | null)?.suggested_moves;
  if (persisted && persisted.length >= 2) {
    return NextResponse.json({ moves: persisted.slice(0, 3) });
  }

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
