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
}: {
  campaignId: string;
  turnNumber: number;
  narration: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const stop = (which?: HTMLAudioElement) => {
    // A stale element's late onended/onerror must never kill a NEWER
    // playback (audit #2): only the current element may stop the show.
    if (which && which !== audioRef.current) return;
    audioRef.current?.pause();
    if (current === audioRef.current) {
      current = null;
      currentStop = null;
    }
    setState("idle");
  };

  const start = async () => {
    // One voice at a time.
    currentStop?.();
    setState("loading");
    const audio = new Audio(
      `/api/campaigns/${campaignId}/tts?turn=${turnNumber}&v=${fingerprint(narration)}`,
    );
    audioRef.current = audio;
    current = audio;
    currentStop = stop;
    audio.onended = () => stop(audio);
    audio.onerror = () => stop(audio);
    try {
      await audio.play();
      if (audioRef.current === audio) setState("playing");
    } catch {
      stop(audio);
    }
  };

  return (
    <button
      type="button"
      onClick={() => (state === "idle" ? start() : stop())}
      className="text-[11px] uppercase tracking-widest text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      aria-label={state === "playing" ? "stop narration audio" : "listen to this narration"}
    >
      {state === "idle" ? "▷ listen" : state === "loading" ? "… loading" : "■ stop"}
    </button>
  );
}
