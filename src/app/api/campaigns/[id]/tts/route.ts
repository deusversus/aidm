import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, modelCalls, turns } from "@/lib/db/schema";
import { synthesize, ttsConfigured } from "@/lib/tts/elevenlabs";
import { speechText } from "@/lib/tts/speech-text";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The listen button (§9.5 media exception, side project 2026-07-18): turn a
 * completed turn's narration into speech. GET with a turn NUMBER — never
 * text — so the server reads the narration from the record and the route
 * cannot be used as an open TTS proxy; and GET so the browser's HTTP cache
 * dedupes re-listens (audio is immutable per turn: narration only changes
 * under rewind, which deletes the turn and the URL with it).
 */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!ttsConfigured()) {
    return NextResponse.json({ error: "voice not configured" }, { status: 503 });
  }

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const turnNumber = Number(new URL(req.url).searchParams.get("turn"));
  if (!Number.isInteger(turnNumber) || turnNumber < 1) {
    return NextResponse.json({ error: "turn required" }, { status: 400 });
  }

  const [turn] = await db
    .select({ narration: turns.narration, status: turns.status })
    .from(turns)
    .where(and(eq(turns.campaignId, id), eq(turns.turnNumber, turnNumber)));
  if (!turn?.narration || (turn.status !== "complete" && turn.status !== "channel")) {
    return NextResponse.json({ error: "no narration for that turn" }, { status: 404 });
  }

  const text = speechText(turn.narration);
  if (!text) return NextResponse.json({ error: "nothing to speak" }, { status: 422 });

  let upstream: Response;
  try {
    upstream = await synthesize(text);
  } catch (err) {
    console.error("[tts] synthesis failed", err);
    return NextResponse.json({ error: "voice synthesis failed" }, { status: 502 });
  }

  // Usage record: ElevenLabs bills ITS OWN subscription credits per
  // character — costUsd 0 keeps the Anthropic ledger honest while the
  // character count preserves the usage trail (§3 metering posture).
  db.insert(modelCalls)
    .values({
      campaignId: id,
      turnNumber,
      provider: "elevenlabs",
      model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
      tier: "tts",
      inputTokens: text.length,
      costUsd: "0",
    })
    .then(
      () => {},
      (err) => console.warn("[tts] usage row failed (non-fatal)", err),
    );

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=604800, immutable",
    },
  });
}
