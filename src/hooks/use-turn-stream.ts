"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Client-side hook for posting to /api/turns and rendering the SSE
 * stream as it arrives. Exposes:
 *   - `send(message)` — POST a new player message
 *   - `cancel()` — abort the in-flight stream
 *   - `streaming` — true while a turn is in flight
 *   - `liveText` — the narrative text as it accumulates
 *   - `routedResponse` — non-null when the router short-circuits
 *     (WorldBuilder clarify/reject, override ack, meta ack)
 *   - `lastTurn` — the most recent `done` event payload
 *   - `error` — terminal error, if any
 */

type TurnEvent =
  | {
      type: "routed";
      verdictKind: "continue" | "meta" | "override" | "worldbuilder";
      response: string | null;
      turnNumber: number;
    }
  | { type: "text"; delta: string }
  | {
      type: "done";
      turnId: string;
      turnNumber: number;
      narrative: string;
      ttftMs: number | null;
      totalMs: number;
      costUsd: number | null;
      portraitNames: string[];
    }
  | { type: "error"; message: string };

export interface UseTurnStreamReturn {
  send: (message: string) => Promise<void>;
  cancel: () => void;
  streaming: boolean;
  liveText: string;
  routedResponse: string | null;
  lastTurn: Extract<TurnEvent, { type: "done" }> | null;
  error: string | null;
}

export function useTurnStream(campaignId: string): UseTurnStreamReturn {
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [routedResponse, setRoutedResponse] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<Extract<TurnEvent, { type: "done" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (message: string) => {
      if (streaming) return;
      setError(null);
      setLiveText("");
      setRoutedResponse(null);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/turns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, message }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          setError(`HTTP ${res.status}: ${text || "request failed"}`);
          setStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Parse SSE frames: "event: <name>\ndata: <json>\n\n"
          let sep: number;
          // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE parse pattern
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const lines = frame.split("\n");
            let eventName: string | null = null;
            let dataLine: string | null = null;
            for (const line of lines) {
              if (line.startsWith("event: ")) eventName = line.slice(7).trim();
              else if (line.startsWith("data: ")) dataLine = line.slice(6);
            }
            if (!eventName || dataLine === null) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(dataLine);
            } catch {
              continue;
            }
            const ev = { type: eventName, ...(parsed as object) } as TurnEvent;
            if (ev.type === "routed") {
              if (ev.response) setRoutedResponse(ev.response);
            } else if (ev.type === "text") {
              setLiveText((t) => t + ev.delta);
            } else if (ev.type === "done") {
              setLastTurn(ev);
            } else if (ev.type === "error") {
              setError(ev.message);
            }
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [campaignId, streaming],
  );

  return { send, cancel, streaming, liveText, routedResponse, lastTurn, error };
}
