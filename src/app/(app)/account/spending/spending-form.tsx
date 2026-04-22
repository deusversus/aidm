"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  initialCap: number | null;
}

/**
 * Client form for /account/spending. Simple local state, POST to
 * /api/user/cap, refresh the page on success so the snapshot panel
 * re-loads from the server.
 */
export function SpendingForm({ initialCap }: Props) {
  const router = useRouter();
  const [value, setValue] = useState<string>(initialCap === null ? "" : initialCap.toFixed(2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (capUsd: number | null) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/user/cap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capUsd }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `http ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      setError("enter a non-negative number, or clear the cap");
      return;
    }
    await submit(parsed);
  };

  const onClear = async () => {
    setValue("");
    await submit(null);
  };

  return (
    <form onSubmit={onSave} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Daily cap (USD)</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 5.00"
            className="w-32 rounded-md border bg-background px-2 py-1 text-sm tabular-nums"
            disabled={submitting}
          />
        </div>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-60"
        >
          {submitting ? "saving…" : "save cap"}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={submitting || initialCap === null}
          className="rounded-md border px-3 py-1.5 text-muted-foreground text-sm hover:text-foreground disabled:opacity-60"
        >
          clear cap
        </button>
      </div>
      {error ? <p className="text-red-600 text-xs">{error}</p> : null}
    </form>
  );
}
