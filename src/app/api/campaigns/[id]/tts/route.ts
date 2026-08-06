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
 * Wrap the upstream audio stream so its completion or failure is logged AND
 * metered — the instrument for the next mid-play stream death (§9.5,
 * 2026-07-20), and since M3R4 B3 the ledger's only writer on this route. It
 * counts bytes and reports whether the segment finished cleanly or the upstream
 * broke; the client receives the same bytes, unchanged.
 *
 * THE OVERCOUNT (found by the 2026-08-06 ElevenLabs calibration): over 30 days
 * model_calls recorded ~359,927 characters across 165 rows while the dashboard
 * measured 53.9K — ~6.7×. The cause was NOT a row per stream chunk, and not the
 * whole narration's length on a segment row (each row already carried only its
 * own segment's text). It was that the route metered the REQUEST, not the
 * SYNTHESIS: the insert fired the moment ElevenLabs' response headers arrived,
 * before a byte reached the client and regardless of whether the client was
 * still there. The listen button opens the NEXT segment eagerly
 * (listen-button.tsx, `preload = "auto"`) and discards it on stop, unmount or
 * navigation — an aborted transfer converts only a fraction of its characters
 * upstream, but wrote a full-length row here. Prefetch-and-abandon at roughly
 * one abandoned request per played one, compounded over restarts, is the
 * multiplier.
 *
 * The rule now: ONE row per COMPLETED synthesis, carrying that synthesis's true
 * character count. A stream that is cancelled or breaks mid-transfer writes NO
 * row and warns with the characters it would have claimed — ElevenLabs meters
 * conversion as it happens, we cannot observe the partial from here, and the
 * dashboard stays the character truth for that residue (a known, logged,
 * under-count-not-over-count gap).
 *
 * THE RACE, resolved by `settled`: completion and cancellation both arrive
 * asynchronously and either can land first. Whoever settles first WINS, and
 * that is the honest ordering in both directions. A cancel arriving BEFORE the
 * final read (the listener walks away mid-transfer) suppresses the row — the
 * conversion never finished. A cancel arriving AFTER the upstream `done` — the
 * element is discarded a beat after the last byte — LOSES, and the row stands:
 * ElevenLabs converted and billed the whole segment, so the ledger owes it a
 * row whether or not anyone stayed to listen.
 *
 * RETRIES are honest by construction: nothing in this route or in
 * `synthesize()` retries. A re-request from the client (a discarded prefetch
 * played again, a restart after an error) is a SECOND upstream POST and second
 * real spend, so it completes into its own row — retries are counted, not
 * deduped.
 */
function meteredStream(
  upstream: ReadableStream<Uint8Array>,
  args: { campaignId: string; chars: number; turnNumber?: number; seg?: number },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let bytes = 0;
  // Exactly-once: a `done` read and a late cancel/error must not both settle.
  let settled = false;

  const abandon = (why: string, detail?: unknown) => {
    if (settled) return;
    settled = true;
    console.warn("[tts] synthesis abandoned — no ledger row", { ...args, bytes, why, detail });
  };

  const complete = () => {
    if (settled) return;
    settled = true;
    console.log("[tts] stream done", { ...args, bytes });
    getDb()
      .insert(modelCalls)
      .values({
        campaignId: args.campaignId,
        turnNumber: args.turnNumber,
        provider: "elevenlabs",
        model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
        tier: "tts",
        phase: "tts",
        // ElevenLabs bills ITS OWN subscription credits per character — costUsd
        // 0 keeps the Anthropic ledger honest while the character count
        // preserves the usage trail (§3 metering posture).
        inputTokens: args.chars,
        costUsd: "0",
      })
      .then(
        () => {},
        (err) => console.warn("[tts] usage row failed (non-fatal)", err),
      );
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          complete();
          controller.close();
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        abandon("upstream stream error", err);
        controller.error(err);
      }
    },
    cancel(reason) {
      abandon("client cancelled", reason);
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
      if (!upstream.body) {
        console.error("[tts] preview upstream returned no body");
        return NextResponse.json({ error: "voice synthesis failed" }, { status: 502 });
      }
      // Same discipline as the segment path: the preview is metered when it
      // finishes converting, never when the request is accepted — a voice
      // menu clicked through quickly abandons previews mid-stream.
      const body = meteredStream(upstream.body, {
        campaignId: id,
        chars: PREVIEW_LINE.length,
      });
      return new Response(body, {
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

  // The usage record rides the stream's completion (see meteredStream): one row
  // per finished segment synthesis, carrying THAT segment's characters.
  return new Response(
    meteredStream(body, { campaignId: id, turnNumber, seg, chars: text.length }),
    {
      headers: {
        "Content-Type": "audio/mpeg",
        // Immutable per (turn, seg, fingerprint) — the URL varies by all three,
        // so per-segment browser caching still makes a re-listen free.
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Segment-Count": String(segments.length),
        "X-Segment-Index": String(seg),
      },
    },
  );
}
