"use client";

import { BudgetIndicator } from "@/components/budget-indicator";
import { FlagSidebar } from "@/components/flag-sidebar";
import { useTurnStream } from "@/hooks/use-turn-stream";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface PriorTurn {
  turn_number: number;
  player_message: string;
  narrative_text: string;
}

interface Props {
  campaignId: string;
  campaignName: string;
  priorTurns: PriorTurn[];
}

/**
 * Play surface. Top = prior narrative feed (read-only). Bottom = input.
 * Streams live narrative into a "live" bubble that flips to a committed
 * turn on `done`. Router short-circuits (WB clarify/reject, override
 * ack) render in the same bubble — they're just non-streaming turns.
 */
export default function PlayUI({ campaignId, campaignName, priorTurns }: Props) {
  const { send, cancel, streaming, liveText, routedResponse, lastTurn, error } =
    useTurnStream(campaignId);
  const [input, setInput] = useState("");
  const [committed, setCommitted] = useState<PriorTurn[]>(priorTurns);
  const [budgetRefreshKey, setBudgetRefreshKey] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track IME composition (Chinese/Japanese/Korean input methods use
  // Enter to confirm candidates) so Enter-to-submit doesn't steal the
  // key while the user is still choosing characters.
  const isComposingRef = useRef(false);
  // Track the player's message at send() time — we need it when `lastTurn`
  // fires later to record what they typed. Using a ref avoids the
  // input-as-effect-dep bug (effect re-firing on every keystroke and
  // double-committing the same turn row with shifting text).
  const pendingMessageRef = useRef<string>("");
  // Dedup on turn_number, not turnId — a failed DB insert yields
  // turnId="" and would collide on subsequent turns, silently
  // dropping them. turn_number is assigned before insert and is
  // unique per campaign.
  const committedTurnNumbersRef = useRef<Set<number>>(new Set());

  // When a turn completes, move it from "live" to "committed" once.
  useEffect(() => {
    if (!lastTurn) return;
    if (committedTurnNumbersRef.current.has(lastTurn.turnNumber)) return;
    committedTurnNumbersRef.current.add(lastTurn.turnNumber);
    setCommitted((prev) => [
      ...prev,
      {
        turn_number: lastTurn.turnNumber,
        player_message: pendingMessageRef.current,
        narrative_text: lastTurn.narrative,
      },
    ]);
    pendingMessageRef.current = "";
    // Nudge BudgetIndicator to re-fetch so the gauge reflects this
    // turn's spend. Chronicler's cost lands on a later update; a
    // second nudge isn't wired (gauge is advisory, not real-time).
    setBudgetRefreshKey((k) => k + 1);
  }, [lastTurn]);

  // Auto-scroll as new content arrives. The deps are triggers (not things
  // the body reads) — biome's exhaustive-deps rule doesn't model that, so
  // we silence it explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are content-change triggers
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [committed, liveText, routedResponse, streaming]);

  const displayedLive = liveText || routedResponse || "";

  // Auto-grow the textarea as the player types. Clamped to ~8 lines so
  // long-form worldbuilding exposition still has a scrollbar rather than
  // pushing the feed off-screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input is the content-change trigger
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxPx = 200; // ~8 lines at default font size
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [input]);

  const submit = async () => {
    const message = input.trim();
    if (!message || streaming) return;
    pendingMessageRef.current = message;
    setInput("");
    await send(message);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter → submit; Shift+Enter → newline (default textarea behavior).
    // IME composition always takes precedence — don't steal the confirm key.
    if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{campaignName}</h1>
        <div className="flex items-center gap-4">
          <BudgetIndicator refreshKey={budgetRefreshKey} />
          <Link
            href={`/campaigns/${campaignId}/settings`}
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            settings
          </Link>
          <span className="text-muted-foreground text-sm">
            {committed.length} turn{committed.length === 1 ? "" : "s"} played
          </span>
        </div>
      </header>

      <div ref={feedRef} className="flex-1 overflow-y-auto rounded-lg border bg-background/40 p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {committed.length === 0 && !streaming && !displayedLive ? (
            <p className="text-muted-foreground italic">
              {
                "Your ship is drifting through Ganymede traffic. The bounty board is blinking. Type what you want to do."
              }
            </p>
          ) : null}

          {committed.map((t) => (
            <div key={t.turn_number} className="flex flex-col gap-2">
              {t.player_message ? (
                <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                  <span className="mr-2 font-mono text-xs opacity-60">you</span>
                  {t.player_message}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed">{t.narrative_text}</p>
            </div>
          ))}

          {streaming && (
            <div className="flex flex-col gap-2">
              {pendingMessageRef.current ? (
                <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                  <span className="mr-2 font-mono text-xs opacity-60">you</span>
                  {pendingMessageRef.current}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed">
                {displayedLive}
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current opacity-60" />
              </p>
            </div>
          )}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          {lastTurn?.flags && lastTurn.flags.length > 0 ? (
            <FlagSidebar flags={lastTurn.flags} turnKey={lastTurn.turnNumber} />
          ) : null}
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          placeholder={streaming ? "…" : "What do you do? (Shift+Enter for newline)"}
          disabled={streaming}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
        {streaming ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border bg-muted px-4 py-2 text-sm hover:bg-muted/70"
          >
            stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            send
          </button>
        )}
      </form>
    </div>
  );
}
