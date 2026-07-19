"use client";

import { fetchWithAuthRetry } from "@/lib/client/fetch-with-auth";
import { plainProse } from "@/lib/client/plain-prose";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListenButton } from "./listen-button";
import { NarrationProse } from "./narration-prose";

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

/** A janitor-proposed near-duplicate pair (§6.5, C1) — resolved by player word. */
interface MergeSuggestion {
  survivor_id: string;
  dupe_id: string;
  survivor_name: string;
  dupe_name: string;
  entity_type: string;
  reason: string;
  confidence: number;
  at_turn: number;
}

interface OpenTurn {
  id: string;
  status: string;
  playerInput: string;
}

/** The decided post-compile capabilities (M2 C5): tier menus + suggestion affordance. */
type TierKey = "narration" | "judgment" | "probe";
type TierMenus = Record<TierKey, string[]>;
type Tiers = Record<TierKey, string>;

interface SettingsResponse {
  tiers: Tiers | null;
  suggestion_affordance: string;
  menus: TierMenus;
}

/** claude-opus-4-8 → "Opus 4.8": strip the prefix, title-case the name, dot the version. */
function friendlyModel(id: string): string {
  const [name, ...version] = id.replace(/^claude-/, "").split("-");
  if (!name) return id;
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return version.length > 0 ? `${title} ${version.join(".")}` : title;
}

/** The SZ conductor's plain cost framing (§8), per tier — static, informational. */
const TIER_COST_FRAMING: Record<TierKey, Record<string, string>> = {
  narration: {
    "claude-sonnet-5": "excellent, standard cost",
    "claude-opus-4-8": "deeper, ~2x",
    "claude-fable-5": "the frontier, ~3x, automatic fallback protection",
  },
  judgment: {
    "claude-haiku-4-5": "fast, lowest cost",
    "claude-sonnet-5": "sharper, standard cost",
    "claude-opus-4-8": "deepest, ~2x",
  },
  probe: {
    "claude-haiku-4-5": "fast, lowest cost",
    "claude-sonnet-5": "sharper, a step up",
  },
};

const TIER_LABELS: Record<TierKey, string> = {
  narration: "Narration — the writer",
  judgment: "Judgment — the rulings",
  probe: "Probe — the quick checks",
};

const AFFORDANCE_OPTIONS: { value: string; label: string; note: string }[] = [
  { value: "default_on", label: "Always", note: "suggested moves appear at each decision point" },
  { value: "on_request_only", label: "On request", note: "only when you ask for them" },
  { value: "never", label: "Never", note: "the studio never offers moves" },
];

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
  ttsAvailable = false,
}: {
  campaignId: string;
  title: string;
  /** Story rows from episodic + channel rows from the turns table (C9). */
  initialExchanges: TranscriptItem[];
  openTurn: OpenTurn | null;
  suggestionAffordance: string;
  /** §9.5 voice: the listen button renders only when the key is configured. */
  ttsAvailable?: boolean;
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
  const [mergeList, setMergeList] = useState<MergeSuggestion[]>([]);
  const [overrideDraft, setOverrideDraft] = useState("");
  // M2 C5 settings drawer: the decided post-compile capabilities. Menus/tiers
  // load lazily on first open (mirrors the notes panel). `affordance` is local
  // state seeded from the prop so a drawer change gates chips without a reload.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [menus, setMenus] = useState<TierMenus | null>(null);
  const [tiers, setTiers] = useState<Tiers | null>(null);
  const [affordance, setAffordance] = useState(suggestionAffordance);
  // Narration is the one player-facing voice: its change waits on an explicit
  // studio-handoff confirm (cache rebuilds cold, voice may shift). This holds
  // the proposed model until the player confirms.
  const [narrationConfirm, setNarrationConfirm] = useState<string | null>(null);
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
  // Live mirror so a mid-turn suggestion-affordance change gates THIS turn's
  // chips without a reload (the same closure-staleness guard as errorRef).
  const affordanceRef = useRef(suggestionAffordance);
  errorRef.current = error;
  affordanceRef.current = affordance;

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
              // §9.2: chips appear by default ONLY when the affordance is
              // default_on. Read live (ref) so a drawer change gates this turn.
              if (
                payload.decisionPoint &&
                payload.suggestedMoves &&
                payload.suggestedMoves.length > 0 &&
                affordanceRef.current === "default_on"
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
    [campaignId],
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
    // The player selects RENDERED text (no markdown syntax); stored
    // narration is raw markdown — match on the plaintext projection.
    const normalized = selection.replace(/\s+/g, " ").trim();
    const source = exchanges.find((e) => plainProse(e.narration).includes(normalized));
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
      const [p, o, m] = await Promise.all([
        fetchWithAuthRetry(`/api/campaigns/${campaignId}/pins`),
        fetchWithAuthRetry(`/api/campaigns/${campaignId}/overrides`),
        fetchWithAuthRetry(`/api/campaigns/${campaignId}/merges`),
      ]);
      if (p.ok) setPinList(((await p.json()) as { pins?: Pin[] }).pins ?? []);
      if (o.ok) setOverrideList(((await o.json()) as { overrides?: Override[] }).overrides ?? []);
      if (m.ok)
        setMergeList(((await m.json()) as { suggestions?: MergeSuggestion[] }).suggestions ?? []);
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

  // §6.5 merge suggestion (C1): the janitor found a near-dup it wouldn't
  // auto-take. Accepting invokes the merge primitive (merge:player); the
  // primitive clears the suggestion, so a refresh drops the row.
  const acceptMerge = async (s: MergeSuggestion) => {
    setNotesBusy(true);
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/merges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ survivor_id: s.survivor_id, dupe_id: s.dupe_id }),
    });
    if (res.ok) {
      setPinNotice(`Merged — “${s.dupe_name}” folded into “${s.survivor_name}.”`);
      setTimeout(() => setPinNotice(null), 4_000);
      await refreshNotes();
    } else {
      setNotesBusy(false);
      setPinNotice("Merge failed.");
      setTimeout(() => setPinNotice(null), 4_000);
    }
  };

  // Dismiss drops the suggestion without merging — player word declines the pair.
  const dismissMerge = async (s: MergeSuggestion) => {
    setNotesBusy(true);
    const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/merges`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ survivor_id: s.survivor_id, dupe_id: s.dupe_id }),
    });
    if (res.ok) await refreshNotes();
    else setNotesBusy(false);
  };

  // M2 C5: the decided capabilities' surface. Menus/tiers/affordance fetched
  // lazily on first open (mirrors the notes panel) — costs nothing until reached.
  const loadSettings = async () => {
    setSettingsBusy(true);
    try {
      const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/settings`);
      if (res.ok) {
        const body = (await res.json()) as SettingsResponse;
        setMenus(body.menus);
        setTiers(body.tiers);
        setAffordance(body.suggestion_affordance);
      }
    } catch {
      // Non-fatal: the drawer shows "unavailable" and reopens clean.
    }
    setSettingsBusy(false);
  };

  const toggleSettings = () => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    if (next && !settingsLoaded) {
      setSettingsLoaded(true);
      void loadSettings();
    }
  };

  // The single PATCH path (§13.1 / §9.2): the strict server body accepts only
  // tier keys and suggestion_affordance. Local state updates on success only;
  // the studio-handoff `note` (present iff narration changed) rides pinNotice.
  const patchSetting = async (patch: Record<string, string>): Promise<boolean> => {
    setSettingsBusy(true);
    let ok = false;
    try {
      const res = await fetchWithAuthRetry(`/api/campaigns/${campaignId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        ok = true;
        // Reconcile from what the server CONFIRMED, never the request body —
        // a write the route couldn't apply must not show as applied (C5
        // audit #1: the drawer never promises what the record didn't do).
        const body = (await res.json().catch(() => ({}))) as {
          note?: string;
          changes?: { field: string; to: string }[];
        };
        for (const change of body.changes ?? []) {
          if (change.field.startsWith("tier.")) {
            const tier = change.field.slice(5);
            setTiers((t) => (t ? { ...t, [tier]: change.to } : t));
          } else if (change.field === "suggestion_affordance") {
            setAffordance(change.to);
          }
        }
        if (body.note) {
          setPinNotice(body.note);
          setTimeout(() => setPinNotice(null), 6_000);
        }
      }
    } catch {
      // Fall through to the error notice below.
    }
    if (!ok) {
      setPinNotice("Couldn't update settings — try again.");
      setTimeout(() => setPinNotice(null), 4_000);
    }
    setSettingsBusy(false);
    return ok;
  };

  // Narration is player-facing voice: the handoff warning gates the change
  // (before, not after). Confirm applies; cancel reverts the select.
  const confirmNarration = async () => {
    if (!narrationConfirm) return;
    const ok = await patchSetting({ narration: narrationConfirm });
    if (ok) setNarrationConfirm(null);
  };

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-6 py-6">
      <header className="flex items-end justify-between border-b border-border pb-3">
        <div>
          <Link
            href="/campaigns"
            className="text-[10px] uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground"
            title="Back to the shelf — your campaigns"
          >
            ← campaigns
          </Link>
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
            onClick={toggleSettings}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
            title="Settings — model tiers and move suggestions"
          >
            Settings
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

          {mergeList.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Possible duplicates</p>
              <ul className="space-y-2">
                {mergeList.map((s) => (
                  <li key={`${s.survivor_id}-${s.dupe_id}`} className="space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs leading-6 text-muted-foreground">
                        {s.dupe_name} <span className="text-muted-foreground/50">→</span>{" "}
                        {s.survivor_name}
                        <span className="text-muted-foreground/50"> · {s.entity_type}</span>
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => void acceptMerge(s)}
                          disabled={notesBusy}
                          className="text-xs text-muted-foreground/60 hover:text-foreground disabled:opacity-50"
                          title="Merge these into one thread"
                        >
                          merge
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismissMerge(s)}
                          disabled={notesBusy}
                          className="text-xs text-muted-foreground/60 hover:text-foreground disabled:opacity-50"
                          title="Not the same — leave them apart"
                        >
                          dismiss
                        </button>
                      </span>
                    </div>
                    <p className="text-[11px] italic leading-5 text-muted-foreground/70">
                      {s.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div className="mt-3 space-y-4 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
              settings
            </p>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="text-xs text-muted-foreground/70 hover:text-muted-foreground"
            >
              close
            </button>
          </div>

          {menus && tiers ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="tier-narration"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {TIER_LABELS.narration}
                </label>
                <select
                  id="tier-narration"
                  value={narrationConfirm ?? tiers.narration}
                  disabled={settingsBusy}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNarrationConfirm(v === tiers.narration ? null : v);
                  }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-foreground disabled:opacity-50"
                >
                  {menus.narration.map((id) => (
                    <option key={id} value={id}>
                      {friendlyModel(id)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground/60">
                  {TIER_COST_FRAMING.narration[narrationConfirm ?? tiers.narration] ?? ""}
                </p>
                {narrationConfirm && (
                  <div className="space-y-2 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2">
                    <p className="text-[11px] leading-5 text-amber-200/90">
                      Studio handoff: the prompt cache rebuilds cold and the voice may shift —
                      change the writer to {friendlyModel(narrationConfirm)}?
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void confirmNarration()}
                        disabled={settingsBusy}
                        className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        change
                      </button>
                      <button
                        type="button"
                        onClick={() => setNarrationConfirm(null)}
                        className="text-xs text-muted-foreground/70 hover:text-muted-foreground"
                      >
                        cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {(["judgment", "probe"] as const).map((tier) => (
                <div key={tier} className="space-y-1">
                  <label
                    htmlFor={`tier-${tier}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {TIER_LABELS[tier]}
                  </label>
                  <select
                    id={`tier-${tier}`}
                    value={tiers[tier]}
                    disabled={settingsBusy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v !== tiers[tier]) void patchSetting({ [tier]: v });
                    }}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-foreground disabled:opacity-50"
                  >
                    {menus[tier].map((id) => (
                      <option key={id} value={id}>
                        {friendlyModel(id)}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground/60">
                    {TIER_COST_FRAMING[tier][tiers[tier]] ?? ""}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground/60">
              {settingsBusy ? "loading…" : "Tiers unavailable."}
            </p>
          )}

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Move suggestions</p>
            <div className="flex flex-wrap gap-2">
              {AFFORDANCE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={settingsBusy}
                  onClick={() => {
                    if (affordance !== o.value)
                      void patchSetting({ suggestion_affordance: o.value });
                  }}
                  className={`rounded-md border px-3 py-1 text-xs disabled:opacity-50 ${
                    affordance === o.value
                      ? "border-foreground bg-muted text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              {AFFORDANCE_OPTIONS.find((o) => o.value === affordance)?.note ?? ""}
            </p>
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
            <NarrationProse
              text={recap}
              className="text-sm italic leading-7 text-muted-foreground [&_em]:not-italic"
            />
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
                  <NarrationProse
                    text={e.narration}
                    className="text-sm italic leading-7 text-foreground/90 [&_em]:not-italic"
                  />
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
              <NarrationProse text={e.narration} />
              {ttsAvailable && e.narration.trim() && (
                <div className="flex justify-end">
                  <ListenButton
                    campaignId={campaignId}
                    turnNumber={e.turnNumber}
                    narration={e.narration}
                  />
                </div>
              )}
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
        {streamText && <NarrationProse text={streamText} streaming />}
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
            <NarrationProse
              text={yokoku}
              className="text-sm italic leading-7 text-muted-foreground [&_em]:not-italic"
            />
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
            {affordance !== "never" && (
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
