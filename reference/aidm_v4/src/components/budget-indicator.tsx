"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * BudgetIndicator — compact header readout for per-user budget state.
 *
 * Three visual states:
 *   - No cap set        → bare today's-spend number + "set daily cap" link.
 *   - Cap set, <50%     → neutral progress bar with $used / $cap.
 *   - Cap set, 50–89%   → yellow (first warn threshold).
 *   - Cap set, ≥90%     → red (second warn threshold).
 *
 * Fetches from /api/budget on mount and on `refreshKey` change. The
 * play screen bumps `refreshKey` after each `done` event so the
 * gauge stays current without polling. SWR-style caching isn't in
 * the project yet; raw fetch + useEffect is fine for the M1 surface.
 */

interface BudgetSnapshot {
  capUsd: number | null;
  usedUsd: number;
  percent: number | null;
  warn50: boolean;
  warn90: boolean;
  rateCount: number;
  rateCap: number;
  nextResetAt: string;
}

interface Props {
  /**
   * Increment to force a re-fetch. The play UI bumps this when a turn
   * completes so the gauge reflects the new spend.
   */
  refreshKey?: number;
}

export function BudgetIndicator({ refreshKey = 0 }: Props) {
  const [snapshot, setSnapshot] = useState<BudgetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/budget", { signal });
      if (!res.ok) {
        setError(`http ${res.status}`);
        return;
      }
      const data = (await res.json()) as BudgetSnapshot;
      setSnapshot(data);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a reactive prop used as a re-fetch trigger
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  if (error) {
    return (
      <span className="text-muted-foreground text-xs" title={error}>
        budget: —
      </span>
    );
  }
  if (!snapshot) {
    return <span className="text-muted-foreground text-xs">budget: …</span>;
  }

  const fmt = (usd: number) => `$${usd.toFixed(2)}`;

  if (snapshot.capUsd === null) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          today: <span className="text-foreground tabular-nums">{fmt(snapshot.usedUsd)}</span>
        </span>
        <Link href="/account/spending" className="text-muted-foreground hover:text-foreground">
          set daily cap
        </Link>
      </div>
    );
  }

  // Cap is set — render progress bar with warn-tier colors.
  const percent = snapshot.percent ?? 0;
  const percentClamped = Math.min(1, percent);
  const color = snapshot.warn90
    ? "bg-red-500"
    : snapshot.warn50
      ? "bg-yellow-500"
      : "bg-emerald-500";
  const textColor = snapshot.warn90
    ? "text-red-600"
    : snapshot.warn50
      ? "text-yellow-600"
      : "text-emerald-700";

  const title = snapshot.warn90
    ? "you're near your daily cap"
    : snapshot.warn50
      ? "over 50% of today's cap"
      : `${Math.round(percent * 100)}% of today's cap`;

  return (
    <Link
      href="/account/spending"
      className="flex items-center gap-2 text-xs hover:underline"
      title={title}
      data-testid="budget-indicator"
    >
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
        data-testid="budget-indicator-bar"
      >
        <div
          className={`h-full ${color} transition-all`}
          style={{ width: `${percentClamped * 100}%` }}
        />
      </div>
      <span className={`tabular-nums ${textColor}`}>
        {fmt(snapshot.usedUsd)} / {fmt(snapshot.capUsd)}
      </span>
    </Link>
  );
}
