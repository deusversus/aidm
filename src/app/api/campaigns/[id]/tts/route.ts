import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, modelCalls, turns } from "@/lib/db/schema";
import { PREVIEW_LINE, availableVoices, synthesize, ttsConfigured } from "@/lib/tts/elevenlabs";
import { speechSegments } from "@/lib/tts/speech-text";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wrap the upstream audio stream so its completion or failure is logged — the
 * instrument for the next mid-play stream death (§9.5, 2026-07-20). It counts
 * bytes and reports whether the segment finished cleanly or the upstream broke;
 * the client receives the same bytes, unchanged.
 */
function instrumentStream(
  upstream: ReadableStream<Uint8Array>,
  turnNumber: number,
  seg: number,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[tts] stream done", { turnNumber, seg, bytes });
          controller.close();
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        console.warn("[tts] upstream stream error", { turnNumber, seg, bytes, err });
        controller.error(err);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

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

  const params2 = new URL(req.url).searchParams;

  // Preview mode: speak the FIXED sample line in a candidate voice — the
  // voice id must come from the available set (no-open-proxy invariant:
  // clients supply neither text nor arbitrary voice ids).
  const previewVoice = params2.get("preview");
  if (previewVoice) {
    const { voices } = await availableVoices();
    if (!voices.some((v) => v.voice_id === previewVoice)) {
      return NextResponse.json({ error: "unknown voice" }, { status: 400 });
    }
    try {
      const upstream = await synthesize(PREVIEW_LINE, previewVoice);
      db.insert(modelCalls)
        .values({
          campaignId: id,
          provider: "elevenlabs",
          model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
          tier: "tts",
          inputTokens: PREVIEW_LINE.length,
          costUsd: "0",
        })
        .then(
          () => {},
          (err) => console.warn("[tts] preview usage row failed (non-fatal)", err),
        );
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "private, max-age=604800, immutable",
        },
      });
    } catch (err) {
      console.error("[tts] preview synthesis failed", err);
      return NextResponse.json({ error: "voice synthesis failed" }, { status: 502 });
    }
  }

  const turnNumber = Number(params2.get("turn"));
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

  // Segmented playback (§9.5, 2026-07-20): the long single MP3 died mid-play
  // ~9 minutes into an 8,683-char scene. The narration is split, server-side,
  // into recoverable segments the client plays in sequence. The client never
  // supplies text — `seg` is only an index into server-computed segments, so
  // the no-open-proxy invariant holds.
  const segments = speechSegments(turn.narration);
  if (segments.length === 0) {
    return NextResponse.json({ error: "nothing to speak" }, { status: 422 });
  }

  // Meta probe: the client learns the segment count up front (an Audio element
  // can't read response headers). No ElevenLabs call, no usage row — cheap and
  // cacheable, so it costs nothing on a re-listen.
  if (params2.get("meta")) {
    return NextResponse.json(
      { segments: segments.length },
      { headers: { "Cache-Control": "private, max-age=604800, immutable" } },
    );
  }

  const segParam = params2.get("seg");
  const seg = segParam === null ? 0 : Number(segParam);
  if (!Number.isInteger(seg) || seg < 0 || seg >= segments.length) {
    return NextResponse.json({ error: "segment out of range" }, { status: 400 });
  }
  const text = segments[seg];
  if (!text) return NextResponse.json({ error: "nothing to speak" }, { status: 422 });

  // The campaign's chosen voice (settings drawer) — server-trusted, never
  // a client parameter; falls back to the env default.
  const chosenVoice = (campaign.voiceSettings as { voice_id?: string } | null)?.voice_id;

  let upstream: Response;
  try {
    upstream = await synthesize(text, chosenVoice);
  } catch (err) {
    console.error("[tts] synthesis failed", err);
    return NextResponse.json({ error: "voice synthesis failed" }, { status: 502 });
  }

  const body = upstream.body;
  if (!body) {
    console.error("[tts] upstream returned no body");
    return NextResponse.json({ error: "voice synthesis failed" }, { status: 502 });
  }

  // Usage record (per segment): ElevenLabs bills ITS OWN subscription credits
  // per character — costUsd 0 keeps the Anthropic ledger honest while the
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

  return new Response(instrumentStream(body, turnNumber, seg), {
    headers: {
      "Content-Type": "audio/mpeg",
      // Immutable per (turn, seg, fingerprint) — the URL varies by all three,
      // so per-segment browser caching still makes a re-listen free.
      "Cache-Control": "private, max-age=604800, immutable",
      "X-Segment-Count": String(segments.length),
      "X-Segment-Index": String(seg),
    },
  });
}
