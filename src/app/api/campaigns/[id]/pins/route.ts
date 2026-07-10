import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, pins } from "@/lib/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Studio-notes panel (§5.4): the active pins, head-of-memory order. */
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
    .select({ id: pins.id, content: pins.content, sourceTurn: pins.sourceTurn })
    .from(pins)
    .where(and(eq(pins.campaignId, id), notTombstoned(pins)))
    .orderBy(asc(pins.position));
  return NextResponse.json({ pins: rows });
}

/** Remove a pin (§5.4): tombstone, never row-delete — provenance survives. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { pinId } = (await req.json().catch(() => ({}))) as { pinId?: string };
  if (!pinId) return NextResponse.json({ error: "pinId required" }, { status: 400 });

  await db
    .update(pins)
    .set({ tombstonedAt: new Date() })
    .where(and(eq(pins.id, pinId), eq(pins.campaignId, id), notTombstoned(pins)));
  return NextResponse.json({ ok: true });
}

/** Pin-from-selection (§5.4): verbatim passage, sourceTurn recorded for dedup. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { content, sourceTurn } = (await req.json().catch(() => ({}))) as {
    content?: string;
    sourceTurn?: number;
  };
  if (!content?.trim()) return NextResponse.json({ error: "empty pin" }, { status: 400 });

  const [{ next }] = (await db
    .select({ next: sql<number>`coalesce(max(${pins.position}), 0) + 1` })
    .from(pins)
    .where(and(eq(pins.campaignId, id), notTombstoned(pins)))) as [{ next: number }];

  await db.insert(pins).values({
    campaignId: id,
    content: content.trim(),
    position: next,
    sourceTurn: sourceTurn ?? 0,
    turnId: sourceTurn ?? 0,
    provenance: "player_pin",
    confidence: 1,
  });
  return NextResponse.json({ ok: true });
}
