"use client";

import type { ClientWorldBuilderFlag } from "@/hooks/use-turn-stream";
import { useState } from "react";

/**
 * FlagSidebar — renders WorldBuilder's typed flags for the most
 * recent turn (WB reshape commit). Each of the three kinds
 * (voice_fit / stakes_implication / internal_consistency) has
 * distinct iconography + copy so the author gets category-specific
 * signal, not a generic "flag" badge.
 *
 * Non-blocking: the turn's narrative already landed. These are
 * editorial notes the author can engage with (retcon, revise) or
 * dismiss. Dismissal is per-turn and UI-local; cross-session
 * persistence is M2+ work.
 */

interface Props {
  flags: ClientWorldBuilderFlag[];
  /**
   * Optional key that resets dismissal state when the player starts a
   * new turn. Play UI passes `lastTurn.turnNumber` so flags from a
   * prior turn don't linger after dismissal state was cleared.
   */
  turnKey?: number | string;
}

interface FlagMeta {
  label: string;
  icon: string;
  accent: string;
  tone: string;
}

const META: Record<ClientWorldBuilderFlag["kind"], FlagMeta> = {
  voice_fit: {
    label: "Voice fit",
    icon: "♪",
    accent: "border-sky-300 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40",
    tone: "text-sky-900 dark:text-sky-200",
  },
  stakes_implication: {
    label: "Stakes implication",
    icon: "⚠",
    accent: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40",
    tone: "text-amber-900 dark:text-amber-200",
  },
  internal_consistency: {
    label: "Prior canon",
    icon: "↩",
    accent: "border-violet-300 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/40",
    tone: "text-violet-900 dark:text-violet-200",
  },
};

export function FlagSidebar({ flags, turnKey }: Props) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [prevKey, setPrevKey] = useState<number | string | undefined>(turnKey);
  // Reset dismissal when the player moves to a new turn. Gated on
  // change so strict-mode double-renders don't loop.
  if (prevKey !== turnKey) {
    setPrevKey(turnKey);
    if (dismissed.size > 0) setDismissed(new Set());
  }

  if (flags.length === 0) return null;
  const visible = flags
    .map((flag, index) => ({ flag, index }))
    .filter(({ index }) => !dismissed.has(index));
  if (visible.length === 0) return null;

  return (
    <aside
      aria-label="Editor flags on this turn"
      className="mx-auto flex max-w-3xl flex-col gap-2"
      data-testid="flag-sidebar"
    >
      {visible.map(({ flag, index }) => {
        const meta = META[flag.kind];
        return (
          <div
            key={`${flag.kind}-${index}`}
            className={`flex items-start gap-3 rounded-md border px-3 py-2 text-xs ${meta.accent}`}
            data-testid={`flag-${flag.kind}`}
          >
            <span aria-hidden className={`text-base leading-none ${meta.tone}`}>
              {meta.icon}
            </span>
            <div className="flex-1">
              <div
                className={`mb-1 font-medium text-[0.72rem] uppercase tracking-wider ${meta.tone}`}
              >
                {meta.label}
              </div>
              <FlagBody flag={flag} />
            </div>
            <button
              type="button"
              aria-label="dismiss flag"
              onClick={() => {
                const next = new Set(dismissed);
                next.add(index);
                setDismissed(next);
              }}
              className="text-muted-foreground text-xs hover:text-foreground"
            >
              ×
            </button>
          </div>
        );
      })}
    </aside>
  );
}

function FlagBody({ flag }: { flag: ClientWorldBuilderFlag }) {
  if (flag.kind === "voice_fit") {
    return (
      <div className="space-y-1">
        <p className="text-foreground/80">{flag.evidence}</p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground/70">Suggestion:</span> {flag.suggestion}
        </p>
      </div>
    );
  }
  if (flag.kind === "stakes_implication") {
    return (
      <div className="space-y-1">
        <p className="text-foreground/80">{flag.evidence}</p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground/70">Dissolves:</span> {flag.what_dissolves}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-foreground/80">{flag.evidence}</p>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground/70">Contradicts:</span> {flag.contradicts}
      </p>
    </div>
  );
}
