"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The listen button (§9.5 media exception): one per completed narration.
 * The audio URL is the TTS route (GET, browser-cached — a re-listen after
 * the first synthesis is free). One voice at a time: starting a narration
 * stops whichever other one is playing.
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
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      // Unmount (rewind, navigation) stops this button's audio.
      if (audioRef.current && current === audioRef.current) {
        audioRef.current.pause();
        current = null;
        currentStop = null;
      }
    };
  }, []);

  const stop = (which?: HTMLAudioElement, failed = false) => {
    // A stale element's late onended/onerror must never kill a NEWER
    // playback (audit #2): only the current element may stop the show.
    if (which && which !== audioRef.current) return;
    audioRef.current?.pause();
    if (current === audioRef.current) {
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

  const start = async () => {
    // One voice at a time.
    currentStop?.();
    setState("loading");
    const audio = new Audio(
      `/api/campaigns/${campaignId}/tts?turn=${turnNumber}&v=${fingerprint(narration + voiceId)}`,
    );
    audioRef.current = audio;
    current = audio;
    currentStop = stop;
    audio.onended = () => stop(audio);
    audio.onerror = () => stop(audio, true);
    try {
      await audio.play();
      if (audioRef.current === audio) setState("playing");
    } catch {
      stop(audio, true);
    }
  };

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
