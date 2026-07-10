import { getCurrentUser } from "@/lib/auth";
import { mintOverride } from "@/lib/booth/booth";
import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, overrides, turns } from "@/lib/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The override ledger (§5.4): standing rules the studio honors every turn,
 * douga included. GET lists the active ledger; POST mints a new rule through
 * the booth's frozen `mintOverride`; DELETE retires one (active=false +
 * removedAt) — never a row-delete, the ledger keeps its history.
 */

/** List active standing rules, mint order. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const rows = await db
    .select({ id: overrides.id, content: overrides.content })
    .from(overrides)
    .where(and(eq(overrides.campaignId, id), eq(overrides.active, true), notTombstoned(overrides)))
    .orderBy(asc(overrides.turnId));
  return NextResponse.json({ overrides: rows });
}

/** Add a standing rule via the frozen booth mint (provenance/confidence set there). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { content } = (await req.json().catch(() => ({}))) as { content?: string };
  if (!content?.trim()) return NextResponse.json({ error: "empty rule" }, { status: 400 });

  // Provenance turn = the campaign's latest turn (the moment the rule was laid down).
  const [last] = await db
    .select({ n: turns.turnNumber })
    .from(turns)
    .where(eq(turns.campaignId, id))
    .orderBy(desc(turns.turnNumber))
    .limit(1);

  const { acknowledgement } = await mintOverride(db, id, last?.n ?? 0, content.trim());
  return NextResponse.json({ ok: true, acknowledgement });
}

/** Retire a standing rule: flip active off, stamp removedAt; the row stays. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { overrideId } = (await req.json().catch(() => ({}))) as { overrideId?: string };
  if (!overrideId) return NextResponse.json({ error: "overrideId required" }, { status: 400 });

  await db
    .update(overrides)
    .set({ active: false, removedAt: new Date() })
    .where(and(eq(overrides.id, overrideId), eq(overrides.campaignId, id)));
  return NextResponse.json({ ok: true });
}
