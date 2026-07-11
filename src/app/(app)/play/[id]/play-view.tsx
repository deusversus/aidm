"use client";

import { fetchWithAuthRetry } from "@/lib/client/fetch-with-auth";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type ChannelIntent = "META_FEEDBACK" | "OVERRIDE_COMMAND" | "OP_COMMAND";

/** A story turn — the default transcript item (kind absent on server-hydrated rows). */
interface Exchange {
  kind?: "story";
  turnNumber: number;
  playerInput: string;
  narration: string;
}

/**
 * An out-of-fiction channel exchange (§5.4): the booth, an override, or an op
 * command. Held in the same transcript array so it renders in place; reload
 * replays the same events, so the shape rehydrates identically.
 */
interface ChannelExchange {
  kind: "channel";
  turnNumber: number;
  playerInput: string;
  /** The streamed studio reply (booth) — empty for a bare command ack. */
  narration: string;
  intent: ChannelIntent;
  responder?: "director" | "ka";
  closed?: boolean;
  acknowledgement?: string;
}

type TranscriptItem = Exchange | ChannelExchange;

/** Phase-A world-assertion feedback (§5.4, editor posture): surfaced honestly, not gated. */
interface AssertionNotice {
  writes: string[];
  clarify?: string;
  flags: string[];
}

interface Pin {
  id: string;
  content: string;
  sourceTurn: number;
}

interface Override {
  id: string;
  content: string;
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
  /** Story rows from episodic + channel rows from the turns table (C9). */
  initialExchanges: TranscriptItem[];
  openTurn: OpenTurn | null;
  suggestionAffordance: string;
}) {
  const [exchanges, setExchanges] = useState<TranscriptItem[]>(initialExchanges);
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [staging, setStaging] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; turnId: string } | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindBusy, setRewindBusy] = useState(false);
  // §5.4 world-assertion feedback: informational, cleared on the next submission.
  const [assertion, setAssertion] = useState<AssertionNotice | null>(null);
  // §9.2 on-demand summon: one probe → the existing chips rail.
  const [summoning, setSummoning] = useState(false);
  // §5.4/§7.5 studio-notes panel: pins + standing rules, fetched lazily, exit-sign quiet.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [pinList, setPinList] = useState<Pin[]>([]);
  const [overrideList, setOverrideList] = useState<Override[]>([]);
  const [overrideDraft, setOverrideDraft] = useState("");
  // §9.4 session lifecycle: recap opens the sitting, yokoku closes it.
  const [recap, setRecap] = useState<string | null>(null);
  const [yokoku, setYokoku] = useState<string | null>(null);
  const [sessionClosed, setSessionClosed] = useState(false);
  const [closing, setClosing] = useState(false);
  // A deep-tier KA can think for minutes before prose streams (sakuga on
  // Opus: observed 3m+). The staging line shows elapsed time past 30s so a
  // long think reads as work, not a hang.
  const [elapsed, setElapsed] = useState(0);
  const openedRef = useRef(false);
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

  // Input typed during a turn queues in memory; a 4-minute sakuga turn plus a
  // reload used to eat it. Mirror the queue to sessionStorage (per campaign)
  // so a reload rehydrates it — the resumed open turn's flush then drains it.
  const queueStorageKey = `aidm:play:queued:${campaignId}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges, streamText, staging, chips, assertion]);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [busy]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(queueStorageKey);
      if (saved) {
        queuedRef.current = saved;
        setQueued(saved);
      }
    } catch {
      // sessionStorage can throw in locked-down contexts — the queue simply
      // doesn't persist; play is unaffected.
    }
  }, [queueStorageKey]);

  useEffect(() => {
    try {
      if (queued) sessionStorage.setItem(queueStorageKey, queued);
      else sessionStorage.removeItem(queueStorageKey);
    } catch {
      // Same as hydration: non-fatal, persistence is best-effort.
    }
  }, [queued, queueStorageKey]);

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
              // §5.4 channel-turn terminal fields.
              intent?: ChannelIntent;
              responder?: "director" | "ka";
              closed?: boolean;
              acknowledgement?: string;
              // §5.4 Phase-A world-assertion feedback.
              writes?: string[];
              clarify?: string;
              flags?: string[];
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
            } else if (event === "assertion") {
              // §5.4 editor posture: writes/clarify/flags surfaced honestly,
              // never gating the scene (which already handled it diegetically).
              setAssertion({
                writes: payload.writes ?? [],
                clarify: payload.clarify,
                flags: payload.flags ?? [],
              });
            } else if (event === "channel") {
              terminal = true;
              setPendingInput(null);
              setStreamText("");
              setExchanges((x) => [
                ...x,
                {
                  kind: "channel",
                  turnNumber: payload.turnNumber ?? 0,
                  playerInput,
                  narration: acc,
                  intent: payload.intent ?? "META_FEEDBACK",
                  responder: payload.responder,
                  closed: payload.closed,
                  acknowledgement: payload.acknowledgement,
                },
              ]);
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
      setAssertion(null);
      setPendingInput(message);
      try {
        const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/turns`, {
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

  // §9.4 open the sitting once on mount. Idempotent server-side (a fresh open
  // session is a no-op); a genuine open may return a premise-rendered recap.
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    void (async () => {
      try {
        const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/session/open`, {
          method: "POST",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { recap?: string };
        if (body.recap) setRecap(body.recap);
      } catch (err) {
        console.warn("session open failed", err);
      }
    })();
  }, [campaignId]);

  const endSession = async () => {
    if (closing || sessionClosed) return;
    setClosing(true);
    try {
      const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/session/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "explicit" }),
      });
      if (res.ok) {
        const body = (await res.json()) as { yokoku?: string };
        if (body.yokoku) setYokoku(body.yokoku);
        setSessionClosed(true);
      } else {
        setPinNotice("Couldn't close the session — try again.");
      }
    } catch {
      setPinNotice("Couldn't close the session — try again.");
    }
    setClosing(false);
  };

  const send = () => {
    if (sessionClosed) return;
    const message = input.trim();
    if (!message) return;
    // A FAILED TURN (error carries its turnId) holds the campaign open: retry
    // it first via the retry affordance, don't stack a new action behind it
    // (that would 409 and re-queue indefinitely). A submit-level error
    // (turnId "") has no open turn and no retry button — a fresh send() is
    // the recovery path, so it must NOT be blocked here.
    if (errorRef.current?.turnId) return;
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
    await fetchWithAuthRetry(`/api/campaigns/${campaignId}/turns/${turnId}/retry`, {
      method: "POST",
    });
    void attachStream(turnId, pendingInput ?? "(retried turn)");
  };

  // §5.6 pre-warm: input focus after >4 min idle fires the cache warmer.
  const onFocus = () => {
    const idleMs = Date.now() - lastActivityRef.current;
    if (idleMs > 4 * 60_000) {
      void fetchWithAuthRetry(`/api/campaigns/${campaignId}/prewarm`, { method: "POST" }).catch(
        () => {},
      );
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
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: selection, sourceTurn: source?.turnNumber ?? 0 }),
    });
    setPinNotice(res.ok ? "Pinned — held verbatim at the head of memory." : "Pin failed.");
    setTimeout(() => setPinNotice(null), 4_000);
  };

  // Rewind (§6.7): "before turn N" un-happens turn N onward — keep everything
  // up to N-1. The durable record IS the UI state, so a reload rehydrates the
  // rewound transcript from the (now-tombstoned-excluded) episodic layer.
  // Story turns only: a booth exchange is out-of-fiction (§5.4) — "before a
  // booth line" is not a place in the story (C9 audit).
  const rewindTargets = exchanges
    .filter((e) => e.kind !== "channel")
    .map((e) => e.turnNumber)
    .slice(-10);
  const rewindTo = async (beforeTurn: number) => {
    setRewindBusy(true);
    try {
      const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toTurn: beforeTurn - 1 }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPinNotice(body.error ?? "Rewind failed.");
    } catch {
      setPinNotice("Rewind failed.");
    }
    setRewindBusy(false);
    setRewindOpen(false);
  };

  // §9.2 on-demand summon: one probe-tier call → the existing chips rail. A
  // pending turn (409) is quiet — the summon simply does nothing this beat.
  const summonSuggestions = async () => {
    if (busy || sessionClosed || summoning) return;
    setSummoning(true);
    try {
      const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/suggestions`, {
        method: "POST",
      });
      if (res.ok) {
        const body = (await res.json()) as { moves?: string[] };
        if (body.moves && body.moves.length > 0) setChips(body.moves);
      }
    } catch {
      // Quiet: the summon is an optional affordance, never a blocking error.
    }
    setSummoning(false);
  };

  // §5.4 studio notes: pins + standing rules. Fetched lazily on first open so
  // the panel costs nothing until the player reaches for it (§7.5).
  const refreshNotes = async () => {
    setNotesBusy(true);
    try {
      const [p, o] = await Promise.all([
        fetchWithAuthRetry(`/api/campaigns/${campaignId}/pins`),
        fetchWithAuthRetry(`/api/campaigns/${campaignId}/overrides`),
      ]);
      if (p.ok) setPinList(((await p.json()) as { pins?: Pin[] }).pins ?? []);
      if (o.ok) setOverrideList(((await o.json()) as { overrides?: Override[] }).overrides ?? []);
    } catch {
      // Non-fatal: the panel just shows what it last had.
    }
    setNotesBusy(false);
  };

  const toggleNotes = () => {
    const next = !notesOpen;
    setNotesOpen(next);
    if (next && !notesLoaded) {
      setNotesLoaded(true);
      void refreshNotes();
    }
  };

  const removePin = async (pinId: string) => {
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/pins`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinId }),
    });
    if (res.ok) setPinList((l) => l.filter((p) => p.id !== pinId));
  };

  const removeOverride = async (overrideId: string) => {
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/overrides`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrideId }),
    });
    if (res.ok) setOverrideList((l) => l.filter((o) => o.id !== overrideId));
  };

  const addOverride = async () => {
    const content = overrideDraft.trim();
    if (!content) return;
    setNotesBusy(true);
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/overrides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (res.ok) {
      setOverrideDraft("");
      await refreshNotes();
    } else {
      setNotesBusy(false);
    }
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
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            href={`/bible/${campaignId}`}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
            title="The Series Bible — the studio's living record of what it heard"
          >
            Series Bible
          </Link>
          <button
            type="button"
            onClick={toggleNotes}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
            title="Studio notes — your pins and standing rules"
          >
            Studio notes
          </button>
          <button
            type="button"
            onClick={() => setRewindOpen((o) => !o)}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
            title="Rewind the story to before an earlier turn — un-happens everything after it"
          >
            Rewind
          </button>
          <button
            type="button"
            onClick={pinSelection}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
            title="Select a passage in the story, then pin it — held verbatim, survives forever"
          >
            Pin selection
          </button>
        </div>
      </header>

      {notesOpen && (
        <div className="mt-3 space-y-4 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
              studio notes
            </p>
            <button
              type="button"
              onClick={() => setNotesOpen(false)}
              className="text-xs text-muted-foreground/70 hover:text-muted-foreground"
            >
              close
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pins</p>
            {pinList.length > 0 ? (
              <ul className="space-y-1">
                {pinList.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-2">
                    <span className="text-xs leading-6 text-muted-foreground">
                      “{p.content}”
                      {p.sourceTurn > 0 && (
                        <span className="text-muted-foreground/50"> · turn {p.sourceTurn}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removePin(p.id)}
                      className="shrink-0 text-xs text-muted-foreground/60 hover:text-foreground"
                      title="Remove this pin"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground/60">
                {notesBusy ? "loading…" : "No pins yet."}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Standing rules</p>
            {overrideList.length > 0 ? (
              <ul className="space-y-1">
                {overrideList.map((o) => (
                  <li key={o.id} className="flex items-start justify-between gap-2">
                    <span className="text-xs leading-6 text-muted-foreground">{o.content}</span>
                    <button
                      type="button"
                      onClick={() => void removeOverride(o.id)}
                      className="shrink-0 text-xs text-muted-foreground/60 hover:text-foreground"
                      title="Retire this standing rule"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground/60">
                {notesBusy ? "loading…" : "No standing rules."}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <input
                value={overrideDraft}
                onChange={(e) => setOverrideDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addOverride();
                  }
                }}
                placeholder="Add a standing rule the studio always honors…"
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-foreground"
              />
              <button
                type="button"
                onClick={() => void addOverride()}
                disabled={!overrideDraft.trim() || notesBusy}
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {rewindOpen && (
        <div className="mt-3 space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
          <p className="text-muted-foreground">
            Rewind un-happens everything after the turn you pick — the story continues from there as
            if the rest never played.
          </p>
          {rewindTargets.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {rewindTargets.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => rewindTo(n)}
                  disabled={rewindBusy}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  title={`Rewind to before turn ${n} — un-happens everything after`}
                >
                  before turn {n}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to rewind yet.</p>
          )}
          <p className="text-xs italic text-muted-foreground">
            One thing can’t be taken back: the model time already spent. Everything inside the story
            itself reverts.
          </p>
          <button
            type="button"
            onClick={() => setRewindOpen(false)}
            className="text-xs text-muted-foreground/70 hover:text-muted-foreground"
          >
            cancel
          </button>
        </div>
      )}

      <div className="flex-1 space-y-5 overflow-y-auto py-4">
        {recap && (
          <div className="border-l-2 border-border pl-4">
            <p className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground/60">
              previously
            </p>
            <p className="whitespace-pre-wrap text-sm italic leading-7 text-muted-foreground">
              {recap}
            </p>
          </div>
        )}
        {exchanges.length === 0 &&
          !pendingInput &&
          !busy &&
          !error &&
          !openTurn &&
          !sessionClosed && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
                episode 1
              </p>
              <h2 className="text-xl font-semibold tracking-tight">The table is set.</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {title} compiled from your Session Zero. The pilot opens cold — begin, or open with
                your own first action below.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (busyRef.current || errorRef.current?.turnId || sessionClosed) return;
                  submitRef.current("Begin.");
                }}
                className="mt-2 rounded-md border border-border bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
              >
                Begin the cold open
              </button>
            </div>
          )}
        {exchanges.map((e, i) => {
          if (e.kind === "channel") {
            const label =
              e.responder === "director"
                ? "THE DIRECTOR"
                : e.responder === "ka"
                  ? "THE WRITER"
                  : "THE STUDIO";
            // Override/op commands are a one-line confirmation, not a room.
            if (e.intent === "OVERRIDE_COMMAND" || e.intent === "OP_COMMAND") {
              return (
                <div
                  key={`channel-${e.turnNumber}-${i}`}
                  className="rounded-md border border-border bg-muted/20 px-4 py-2 text-sm"
                >
                  <p className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground/60">
                    standing rule set
                  </p>
                  <p className="text-xs italic text-muted-foreground/70">“{e.playerInput}”</p>
                  <p className="mt-1 text-muted-foreground">{e.acknowledgement ?? e.narration}</p>
                </div>
              );
            }
            // The booth: a bracketed studio room, clearly out of the fiction.
            return (
              <div
                key={`channel-${e.turnNumber}-${i}`}
                className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 px-4 py-3"
              >
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
                  {label} · booth
                </p>
                <p className="text-sm text-muted-foreground">{e.playerInput}</p>
                {e.narration && (
                  <p className="whitespace-pre-wrap text-sm italic leading-7 text-foreground/90">
                    {e.narration}
                  </p>
                )}
                {e.closed && (
                  <p className="text-[11px] italic text-muted-foreground/60">
                    booth resolved — calibrations recorded
                  </p>
                )}
              </div>
            );
          }
          return (
            <div key={`story-${e.turnNumber}-${i}`} className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-foreground px-3 py-2 text-sm text-background">
                  {e.playerInput}
                </div>
              </div>
              <div className="whitespace-pre-wrap text-[15px] leading-7">{e.narration}</div>
            </div>
          );
        })}
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
        {staging && (
          <p className="text-xs italic text-muted-foreground">
            {staging}…
            {elapsed >= 30 &&
              ` ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
          </p>
        )}
        {assertion &&
          (assertion.writes.length > 0 || assertion.clarify || assertion.flags.length > 0) && (
            <div className="space-y-1">
              {assertion.writes.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">
                    Canon updated — {assertion.writes.length} write
                    {assertion.writes.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground/80">
                    {assertion.writes.map((w, i) => (
                      <li key={`${i}-${w.slice(0, 24)}`}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              {assertion.clarify && (
                <p className="rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
                  The studio needs a beat of clarity: {assertion.clarify}
                </p>
              )}
              {assertion.flags.length > 0 && (
                <p className="text-xs text-muted-foreground/60">
                  Noted for the Director: {assertion.flags.join("; ")}
                </p>
              )}
            </div>
          )}
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
        {yokoku && (
          <div className="border-l-2 border-border pl-4">
            <p className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground/60">
              next time
            </p>
            <p className="whitespace-pre-wrap text-sm italic leading-7 text-muted-foreground">
              {yokoku}
            </p>
          </div>
        )}
        {sessionClosed && (
          <p className="text-xs italic text-muted-foreground">
            Session closed — reopen it from the shelf when you’re ready for the next sitting.
          </p>
        )}
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
            placeholder={
              sessionClosed
                ? "the sitting is over"
                : busy
                  ? "type away — it sends when the scene lands"
                  : "What do you do?"
            }
            rows={2}
            disabled={sessionClosed}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground disabled:opacity-50"
          />
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || sessionClosed}
            className="rounded-md border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy ? "Queue" : "Act"}
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div>
            {suggestionAffordance !== "never" && (
              <button
                type="button"
                onClick={() => void summonSuggestions()}
                disabled={busy || sessionClosed || summoning}
                title="Ask the studio for a few premise-true next moves"
                className="text-xs text-muted-foreground/70 hover:text-muted-foreground disabled:opacity-50"
              >
                {summoning ? "thinking…" : "Suggest moves"}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={endSession}
            disabled={closing || sessionClosed || busy}
            title="End this sitting — writes the session's notes and shows next time's tease"
            className="text-xs text-muted-foreground/70 hover:text-muted-foreground disabled:opacity-50"
          >
            {closing ? "closing…" : "End session"}
          </button>
        </div>
      </footer>
    </main>
  );
}
