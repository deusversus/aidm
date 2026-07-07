"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "player" | "conductor";
  text: string;
}

/**
 * The Session Zero chat: streams conductor turns over SSE. The kickoff turn
 * (empty message — the conductor speaks first) fires automatically on a
 * fresh draft; a reloaded draft resumes from the server-rehydrated
 * transcript.
 */
export function SzChat({
  campaignId,
  initialMessages,
  initialReady,
}: {
  campaignId: string;
  initialMessages: ChatMessage[];
  initialReady: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [streamText, setStreamText] = useState("");
  const [staging, setStaging] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(initialReady);
  const [compiling, setCompiling] = useState(false);
  const [gaps, setGaps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  // Synchronous in-flight gate: `busy` state is render-lagged, and a
  // keystroke landing between the turn's finally and the busy=false commit
  // would queue a message nothing ever drains. Refs don't go stale.
  const busyRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const kickoffFired = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows every content change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, staging]);

  const runTurn = useCallback(
    async (message: string) => {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setStreamText("");
      let acc = "";
      try {
        const res = await fetch(`/api/sz/${campaignId}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `turn failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            let event = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (!data) continue;
            const payload = JSON.parse(data) as {
              text?: string;
              message?: string;
              readyToCompile?: boolean;
            };
            if (event === "text" && payload.text) {
              acc += payload.text;
              setStreamText(acc);
              setStaging(null);
            } else if (event === "staging" && payload.text) {
              setStaging(payload.text);
            } else if (event === "ready_to_compile") {
              setReady(true);
            } else if (event === "error") {
              throw new Error(payload.message ?? "conductor turn failed");
            }
          }
        }
        if (acc.trim()) setMessages((m) => [...m, { role: "conductor", text: acc }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "the conductor lost the thread — try again");
        // The server persisted nothing for a failed turn — showing the
        // partial reply or keeping the player bubble would diverge from the
        // durable transcript the next turn is built on. Roll both back and
        // hand the words back to the player.
        if (message) {
          setMessages((m) =>
            m.length > 0 && m[m.length - 1]?.role === "player" ? m.slice(0, -1) : m,
          );
          const q = queuedRef.current;
          queuedRef.current = null;
          setQueued(null);
          setInput((prev) => [message, q, prev.trim() || null].filter(Boolean).join("\n"));
        }
      } finally {
        setStreamText("");
        setStaging(null);
        busyRef.current = false;
        setBusy(false);
        // No dead air (§8): whatever the player typed while the conductor
        // worked (interview answers during research) fires immediately.
        // Single-threaded with send()'s busyRef gate — no strand window.
        const q = queuedRef.current;
        if (q) {
          queuedRef.current = null;
          setQueued(null);
          setMessages((m) => [...m, { role: "player", text: q }]);
          void runTurn(q);
        }
      }
    },
    [campaignId],
  );

  // A fresh draft: the conductor speaks first (§8).
  useEffect(() => {
    if (initialMessages.length === 0 && !kickoffFired.current) {
      kickoffFired.current = true;
      void runTurn("");
    }
  }, [initialMessages.length, runTurn]);

  const send = () => {
    const message = input.trim();
    if (!message) return;
    if (busyRef.current) {
      // Mid-turn (often mid-research): queue it — the conversation never
      // makes the player wait to speak.
      queuedRef.current = queuedRef.current ? `${queuedRef.current}\n${message}` : message;
      setQueued(queuedRef.current);
      setInput("");
      return;
    }
    setMessages((m) => [...m, { role: "player", text: message }]);
    setInput("");
    void runTurn(message);
  };

  const compile = async () => {
    setCompiling(true);
    setError(null);
    setGaps([]);
    try {
      const res = await fetch(`/api/sz/${campaignId}/compile`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; gaps?: string[]; error?: string };
      if (body.ok) {
        router.refresh();
        return;
      }
      if (body.gaps?.length) setGaps(body.gaps);
      else setError(body.error ?? "compile failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "compile failed");
    } finally {
      setCompiling(false);
    }
  };

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col px-6 py-6">
      <header className="border-b border-border pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Session Zero</h1>
        <p className="text-xs text-muted-foreground">One conversation. The table gets set here.</p>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto py-4">
        {messages.map((m, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
            key={i}
            className={m.role === "player" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={
                m.role === "player"
                  ? "max-w-[85%] whitespace-pre-wrap rounded-lg bg-foreground px-3 py-2 text-sm text-background"
                  : "max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm"
              }
            >
              {m.text}
            </div>
          </div>
        ))}
        {streamText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">
              {streamText}
              <span className="animate-pulse">▋</span>
            </div>
          </div>
        )}
        {staging && <p className="text-xs italic text-muted-foreground">{staging}</p>}
        {busy && !streamText && !staging && (
          <p className="text-xs italic text-muted-foreground">the conductor is thinking…</p>
        )}
        {gaps.length > 0 && (
          <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
            <p className="font-medium">Not ready to compile yet:</p>
            <ul className="list-disc pl-4">
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        {queued && (
          <p className="text-right text-xs italic text-muted-foreground">
            queued — sends when the conductor finishes: “{queued}”
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="space-y-2 border-t border-border pt-3">
        {ready && (
          <button
            type="button"
            onClick={compile}
            disabled={busy || compiling}
            className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {compiling ? "Setting the table…" : "The table is set — begin the campaign"}
          </button>
        )}
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              busy ? "type away — it sends when the conductor finishes" : "Say something"
            }
            rows={2}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim()}
            className="rounded-md border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy ? "Queue" : "Send"}
          </button>
        </div>
      </footer>
    </main>
  );
}
