"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "archive" | "unarchive" | "delete";

/**
 * Shelf row controls (§9.1): archive/unarchive/soft-delete. Delete is a
 * two-click confirm (the removal is soft — status "deleted", recoverable —
 * but the row leaves the shelf, so guard the accident). Refreshes the server
 * component on success. Which controls show is status-driven and mirrors the
 * route's legal transitions: compiling rows get none.
 */
export function ShelfActions({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: Action) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/shelf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `could not ${action}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `could not ${action}`);
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const canArchive = status === "active";
  const canUnarchive = status === "archived";
  const canDelete = status === "active" || status === "archived" || status === "draft";
  if (!canArchive && !canUnarchive && !canDelete) return null;

  const btn =
    "rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50";

  return (
    <div className="flex shrink-0 items-center gap-1">
      {error && <span className="text-[10px] text-red-500">{error}</span>}
      {canArchive && (
        <button type="button" onClick={() => act("archive")} disabled={busy} className={btn}>
          Archive
        </button>
      )}
      {canUnarchive && (
        <button type="button" onClick={() => act("unarchive")} disabled={busy} className={btn}>
          Unarchive
        </button>
      )}
      {canDelete &&
        (confirmDelete ? (
          <>
            <button type="button" onClick={() => act("delete")} disabled={busy} className={btn}>
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              className={`${btn} border-transparent`}
            >
              cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className={btn}
          >
            Delete
          </button>
        ))}
    </div>
  );
}
