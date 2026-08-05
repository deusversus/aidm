import { getCurrentUser } from "@/lib/auth";
import { PIN_MAX_COUNT, PIN_MAX_TOKENS, selectPins } from "@/lib/blocks/assemble";
import { compactionWatermark } from "@/lib/blocks/compaction";
import { approxTokens } from "@/lib/blocks/tokens";
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

  const [inserted] = await db
    .insert(pins)
    .values({
      campaignId: id,
      content: content.trim(),
      position: next,
      sourceTurn: sourceTurn ?? 0,
      turnId: sourceTurn ?? 0,
      provenance: "player_pin",
      confidence: 1,
    })
    .returning({ id: pins.id });

  // §5.4 droppedPins, surfaced (M3R2 C5). `assembleBlocks` has always computed
  // which pins the head of memory can actually carry — the ≤5/≤2k bound, and
  // the window dedup that withholds a pin whose source scene is still verbatim
  // — and no caller ever read the list. So the surface told the player
  // "Pinned — held verbatim at the head of memory" for a pin the assembler was
  // silently dropping. The same selection runs here, and the answer rides the
  // existing pin-notice line: no new UI, just a true sentence.
  const [rows, watermark] = await Promise.all([
    db
      .select({
        id: pins.id,
        content: pins.content,
        position: pins.position,
        sourceTurn: pins.sourceTurn,
      })
      .from(pins)
      .where(and(eq(pins.campaignId, id), notTombstoned(pins)))
      .orderBy(asc(pins.position), asc(pins.id)),
    compactionWatermark(db, id),
  ]);
  const trimmed = content.trim();
  const pinRows = rows.map((p) => ({
    position: p.position,
    content: p.content,
    sourceTurn: p.sourceTurn,
  }));
  const { kept } = selectPins(pinRows, watermark);
  const carried = kept.some((p) => p.content === trimmed);
  const stillInWindow = (sourceTurn ?? 0) > watermark;

  // The two drop conditions are INDEPENDENT, and the surface used to hear only
  // the first (M3R3 close): `in_window` short-circuits ahead of the bound, and
  // by construction a fresh pin comes from a scene still quoted verbatim in
  // Block 3 — so "it joins the head once that scene compacts" was the answer
  // even when the head was already full and the pin would be dropped again the
  // instant it became eligible. Both are computed now. The second re-runs the
  // SAME selection with this pin — and only this pin — moved to the eligible
  // side of the watermark, which is exactly the question "will there be room
  // for it later?" `reason` keeps its old shape; the rest is additive.
  const isThisPin = (p: { position: number; content: string }) =>
    p.position === next && p.content === trimmed;
  const eligible = selectPins(
    pinRows.map((p) =>
      isThisPin(p) ? { ...p, sourceTurn: Math.min(p.sourceTurn, watermark) } : p,
    ),
    watermark,
  );
  const wouldExceedBudget = !eligible.kept.some(isThisPin);

  return NextResponse.json({
    ok: true,
    id: inserted?.id,
    carried,
    // The two drop reasons are completely different news for the player: one
    // is "it will be carried, later, by design"; the other is "make room".
    reason: carried ? undefined : stillInWindow ? "in_window" : "budget",
    // Additive: true when the head has no room for this pin even once the
    // window releases it — "later" is then only half the answer.
    wouldExceedBudget,
    // What the head is actually holding right now, so the notice can name the
    // bound that binds (passages or tokens) instead of guessing.
    head: { count: kept.length, tokens: kept.reduce((n, p) => n + approxTokens(p.content), 0) },
    limits: { maxCount: PIN_MAX_COUNT, maxTokens: PIN_MAX_TOKENS },
  });
}
