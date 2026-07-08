"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Exchange {
  turnNumber: number;
  playerInput: string;
  narration: string;
}

interface OpenTurn {
  id: string;
  status: string;
  playerInput: string;
}

/**
 * The play view client: submits turns, streams SSE progress, renders
 * decision-point chips (dismissible, never in prose), typed errors with
 * retry, queued input, pin-from-selection, and the §5.6 pre-warm on input
 * focus after idle.
 */
export function PlayView({
  campaignId,
  title,
  initialExchanges,
  openTurn,
  suggestionAffordance,
}: {
  campaignId: string;
  title: string;
  initialExchanges: Exchange[];
  openTurn: OpenTurn | null;
  suggestionAffordance: string;
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>(initialExchanges);
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [staging, setStaging] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; turnId: string } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  // Live mirrors of state read inside long-running async closures (the C3
  // lesson: a captured `error`/`submit` goes stale mid-stream and can loop).
  const errorRef = useRef<{ message: string; turnId: string } | null>(null);
  const submitRef = useRef<(m: string) => void>(() => {});
  const lastActivityRef = useRef(Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const resumedRef = useRef(false);
  errorRef.current = error;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges, streamText, staging, chips]);

  const attachStream = useCallback(
    async (turnId: string, playerInput: string, retries = 0) => {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setChips([]);
      let acc = "";
      let terminal = false;
      let hadError = false;
      let reconnecting = false;
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/turns/${turnId}/stream`);
        if (!res.ok || !res.body) {
          // Auth/gone are terminal — never spin on them.
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            throw Object.assign(new Error(`stream unavailable (${res.status})`), { fatal: true });
          }
          throw new Error(`stream failed (${res.status})`);
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
              turnNumber?: number;
              decisionPoint?: boolean;
              suggestedMoves?: string[];
              retryable?: boolean;
            };
            if (event === "prose" && payload.text) {
              acc += payload.text;
              setStreamText(acc);
              setStaging(null);
            } else if (event === "staging" && payload.text) {
              setStaging(payload.text);
            } else if (event === "reset") {
              acc = "";
              setStreamText("");
            } else if (event === "done") {
              terminal = true;
              setExchanges((x) => [
                ...x,
                { turnNumber: payload.turnNumber ?? 0, playerInput, narration: acc },
              ]);
              setStreamText("");
              setPendingInput(null);
              // §9.2: chips appear by default ONLY when SZ set default_on.
              if (
                payload.decisionPoint &&
                payload.suggestedMoves &&
                payload.suggestedMoves.length > 0 &&
                suggestionAffordance === "default_on"
              ) {
                setChips(payload.suggestedMoves);
              }
            } else if (event === "channel") {
              terminal = true;
              setPendingInput(null);
              setStreamText("");
              setPinNotice("The studio heard you — the meta booth opens in a later build.");
            } else if (event === "error") {
              terminal = true;
              hadError = true;
              setError({ message: payload.message ?? "the turn failed", turnId });
              setStreamText("");
            }
          }
        }
        // Stream ended without a terminal event (network hiccup): the turn is
        // durable — re-attach and the server replays or resumes.
        if (!terminal) reconnecting = true;
      } catch (err) {
        // Fatal (auth/gone) or retries exhausted: stop spinning, surface a
        // reload affordance — the turn is durable, the transport gave up.
        if ((err as { fatal?: boolean })?.fatal || retries >= 5) {
          busyRef.current = false;
          setBusy(false);
          setStaging(null);
          setError({
            message:
              "Lost the connection to this scene. Reload to pick it back up — your turn is saved.",
            turnId,
          });
          return;
        }
        reconnecting = true;
      } finally {
        // Preserve the "reconnecting…" indicator across the reschedule.
        if (!reconnecting) setStaging(null);
      }
      if (reconnecting) {
        setStaging("reconnecting…");
        const backoff = Math.min(1_500 * 2 ** retries, 15_000);
        setTimeout(() => void attachStream(turnId, playerInput, retries + 1), backoff);
        return;
      }
      busyRef.current = false;
      setBusy(false);
      // Drain a queued input only if this turn did NOT fail — a failed turn
      // waits on the retry affordance, never an auto-resubmit (which would
      // loop against the still-open failed turn). hadError is local, so it's
      // reliable where the `error` state closure would be stale.
      const q = queuedRef.current;
      if (q && !hadError) {
        queuedRef.current = null;
        setQueued(null);
        void submitRef.current(q);
      }
    },
    [campaignId, suggestionAffordance],
  );

  const submit = useCallback(
    async (message: string) => {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setChips([]);
      setPendingInput(message);
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        const body = (await res.json()) as { turnId?: string; pending?: string; error?: string };
        if (res.status === 409 && body.pending) {
          // A turn is still open — hold this input and attach to the open one.
          queuedRef.current = queuedRef.current ? `${queuedRef.current}\n${message}` : message;
          setQueued(queuedRef.current);
          setPendingInput(null);
          void attachStream(body.pending, "(previous turn)");
          return;
        }
        if (!res.ok || !body.turnId) throw new Error(body.error ?? `submit failed (${res.status})`);
        await attachStream(body.turnId, message);
      } catch (err) {
        busyRef.current = false;
        setBusy(false);
        setPendingInput(null);
        setInput((prev) => (prev.trim() ? prev : message));
        setError({
          message: err instanceof Error ? err.message : "the turn failed to submit",
          turnId: "",
        });
      }
    },
    [campaignId, attachStream],
  );
  submitRef.current = submit;

  // Resume an open turn on load (§5.7: reconnect finds it, never loses it).
  useEffect(() => {
    if (openTurn && !resumedRef.current) {
      resumedRef.current = true;
      setPendingInput(openTurn.playerInput);
      if (openTurn.status === "failed") {
        setError({
          message:
            "The scene failed to render twice. Your action is saved — retry when ready; the dice stay as they fell.",
          turnId: openTurn.id,
        });
      } else {
        void attachStream(openTurn.id, openTurn.playerInput);
      }
    }
  }, [openTurn, attachStream]);

  const send = () => {
    const message = input.trim();
    if (!message) return;
    // A failed turn holds the campaign open: retry it first, don't stack a
    // new action behind it (that would 409 and re-queue indefinitely).
    if (errorRef.current) return;
    if (busyRef.current) {
      queuedRef.current = queuedRef.current ? `${queuedRef.current}\n${message}` : message;
      setQueued(queuedRef.current);
      setInput("");
      return;
    }
    setInput("");
    void submit(message);
  };

  const retry = async () => {
    if (!error?.turnId) return;
    const turnId = error.turnId;
    setError(null);
    await fetch(`/api/campaigns/${campaignId}/turns/${turnId}/retry`, { method: "POST" });
    void attachStream(turnId, pendingInput ?? "(retried turn)");
  };

  // §5.6 pre-warm: input focus after >4 min idle fires the cache warmer.
  const onFocus = () => {
    const idleMs = Date.now() - lastActivityRef.current;
    if (idleMs > 4 * 60_000) {
      void fetch(`/api/campaigns/${campaignId}/prewarm`, { method: "POST" }).catch(() => {});
    }
    lastActivityRef.current = Date.now();
  };

  // Pin-from-selection: select narration text, pin it verbatim (§5.4).
  const pinSelection = async () => {
    const selection = window.getSelection()?.toString().trim();
    if (!selection) {
      setPinNotice("Select a passage in the story first.");
      return;
    }
    const source = exchanges.find((e) => e.narration.includes(selection));
    const res = await fetch(`/api/campaigns/${campaignId}/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: selection, sourceTurn: source?.turnNumber ?? 0 }),
    });
    setPinNotice(res.ok ? "Pinned — held verbatim at the head of memory." : "Pin failed.");
    setTimeout(() => setPinNotice(null), 4_000);
  };

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-6 py-6">
      <header className="flex items-end justify-between border-b border-border pb-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-xs text-muted-foreground">
            Say what you do. The studio does the rest.
          </p>
        </div>
        <button
          type="button"
          onClick={pinSelection}
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
          title="Select a passage in the story, then pin it — held verbatim, survives forever"
        >
          Pin selection
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto py-4">
        {exchanges.map((e) => (
          <div key={e.turnNumber} className="space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-foreground px-3 py-2 text-sm text-background">
                {e.playerInput}
              </div>
            </div>
            <div className="whitespace-pre-wrap text-[15px] leading-7">{e.narration}</div>
          </div>
        ))}
        {pendingInput && (
          <div className="flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-foreground px-3 py-2 text-sm text-background opacity-80">
              {pendingInput}
            </div>
          </div>
        )}
        {streamText && (
          <div className="whitespace-pre-wrap text-[15px] leading-7">
            {streamText}
            <span className="animate-pulse">▋</span>
          </div>
        )}
        {staging && <p className="text-xs italic text-muted-foreground">{staging}…</p>}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setChips([]);
                  setInput(c);
                }}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                {c}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setChips([])}
              className="rounded-full px-2 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground"
            >
              dismiss
            </button>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-sm">
            <p>{error.message}</p>
            {error.turnId && (
              <button
                type="button"
                onClick={retry}
                className="mt-2 rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
              >
                Retry the scene
              </button>
            )}
          </div>
        )}
        {queued && (
          <p className="text-right text-xs italic text-muted-foreground">
            queued — sends when the scene lands: “{queued}”
          </p>
        )}
        {pinNotice && <p className="text-xs text-muted-foreground">{pinNotice}</p>}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-border pt-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={onFocus}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={busy ? "type away — it sends when the scene lands" : "What do you do?"}
            rows={2}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim()}
            className="rounded-md border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy ? "Queue" : "Act"}
          </button>
        </div>
      </footer>
    </main>
  );
}
