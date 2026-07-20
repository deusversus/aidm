"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The listen button (§9.5 media exception): one per completed narration.
 * Long scenes are synthesized as multiple segments (§9.5, 2026-07-20 — a
 * ~9-minute single stream died mid-play); the button learns the segment count
 * from a cheap meta probe, then plays the segments in sequence, prefetching the
 * next for a near-gapless handoff. One voice at a time: starting a narration
 * stops whichever other one is playing. The segment URLs are the TTS route
 * (GET, browser-cached — a re-listen after the first synthesis is free).
 */

let current: HTMLAudioElement | null = null;
let currentStop: (() => void) | null = null;

/** Cheap content fingerprint (djb2): a rewind can REPLAY a turn number with
 *  new narration — the fingerprint in the URL keeps the browser cache from
 *  serving the dead timeline's audio (audit #1). */
function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function ListenButton({
  campaignId,
  turnNumber,
  narration,
  voiceId = "",
}: {
  campaignId: string;
  turnNumber: number;
  narration: string;
  /** Cache-bust only — the SERVER resolves the voice from the campaign row;
   *  this just keeps a voice change from replaying the old voice's cache. */
  voiceId?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);
  const segCountRef = useRef(0);
  // Bumped on every start / stop / cancel so a stale element's late
  // onended/onerror (a handed-off segment, or a discarded prefetch) can never
  // drive a newer run — the segmented cousin of the which!==audioRef guard.
  const runIdRef = useRef(0);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cacheBust = fingerprint(narration + voiceId);
  const segUrl = (k: number) =>
    `/api/campaigns/${campaignId}/tts?turn=${turnNumber}&seg=${k}&v=${cacheBust}`;
  const metaUrl = () => `/api/campaigns/${campaignId}/tts?turn=${turnNumber}&meta=1&v=${cacheBust}`;

  const discardPrefetch = () => {
    const next = prefetchRef.current;
    if (next) {
      next.onended = null;
      next.onerror = null;
      next.pause();
      next.removeAttribute("src");
      prefetchRef.current = null;
    }
  };

  const stop = (which?: HTMLAudioElement, failed = false) => {
    // A stale element's late onended/onerror must never kill a NEWER
    // playback (audit #2): only the active element may stop the show.
    if (which && which !== audioRef.current) return;
    // Invalidate any pending handoff / play() resolution from this run.
    runIdRef.current++;
    const active = audioRef.current;
    active?.pause();
    discardPrefetch();
    audioRef.current = null;
    if (current === active) {
      current = null;
      currentStop = null;
    }
    if (failed) {
      // A silent bounce back to "listen" reads as a broken button (live
      // finding: an upstream quota 502 gave zero feedback). Brief, honest,
      // self-clearing — and a NEW error re-arms the timer so a stale one
      // can't truncate its 3 seconds (audit).
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      setState("error");
      errorTimerRef.current = setTimeout(() => {
        errorTimerRef.current = null;
        setState((s) => (s === "error" ? "idle" : s));
      }, 3_000);
    } else {
      setState("idle");
    }
  };

  const playSegment = (k: number, audio: HTMLAudioElement, myRun: number) => {
    audioRef.current = audio;
    current = audio;
    currentStop = stop;

    audio.onended = () => {
      if (runIdRef.current !== myRun || audio !== audioRef.current) return;
      // The finished element is retired here so its late events go silent; the
      // handoff repoints audioRef at the next segment.
      audio.onended = null;
      audio.onerror = null;
      const nextIndex = k + 1;
      if (nextIndex >= segCountRef.current) {
        stop(audio); // whole scene spoken → idle
        return;
      }
      const next = prefetchRef.current ?? new Audio(segUrl(nextIndex));
      prefetchRef.current = null;
      playSegment(nextIndex, next, myRun);
    };

    audio.onerror = () => {
      if (runIdRef.current !== myRun || audio !== audioRef.current) return;
      stop(audio, true);
    };

    // Prefetch the next segment so the handoff is near-gapless.
    discardPrefetch();
    const nextIndex = k + 1;
    if (nextIndex < segCountRef.current) {
      const next = new Audio(segUrl(nextIndex));
      next.preload = "auto";
      prefetchRef.current = next;
    }

    audio.play().then(
      () => {
        if (runIdRef.current === myRun && audio === audioRef.current) setState("playing");
      },
      () => {
        if (runIdRef.current === myRun && audio === audioRef.current) stop(audio, true);
      },
    );
  };

  const start = async () => {
    currentStop?.(); // one voice at a time
    const myRun = ++runIdRef.current;
    // Claim the singleton during the meta round-trip so a competing start can
    // cancel this run before its first element exists (no two-voice window).
    currentStop = stop;
    current = null;
    setState("loading");

    let count: number;
    try {
      const res = await fetch(metaUrl());
      if (!res.ok) throw new Error(`meta ${res.status}`);
      const data = (await res.json()) as { segments?: number };
      count = typeof data.segments === "number" ? data.segments : 0;
    } catch {
      if (runIdRef.current === myRun) stop(undefined, true);
      return;
    }
    if (runIdRef.current !== myRun) return; // superseded (or stopped) mid-fetch
    if (count < 1) {
      stop(undefined, true);
      return;
    }
    segCountRef.current = count;
    playSegment(0, new Audio(segUrl(0)), myRun);
  };

  useEffect(() => {
    return () => {
      // Unmount (rewind, navigation) stops this button's audio + prefetch.
      runIdRef.current++;
      const active = audioRef.current;
      active?.pause();
      const next = prefetchRef.current;
      if (next) {
        next.pause();
        next.removeAttribute("src");
        prefetchRef.current = null;
      }
      audioRef.current = null;
      if (current === active) {
        current = null;
        currentStop = null;
      }
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => (state === "idle" || state === "error" ? start() : stop())}
      className="text-[11px] uppercase tracking-widest text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      aria-label={state === "playing" ? "stop narration audio" : "listen to this narration"}
    >
      {state === "idle"
        ? "▷ listen"
        : state === "loading"
          ? "… loading"
          : state === "error"
            ? "✕ voice unavailable"
            : "■ stop"}
    </button>
  );
}
