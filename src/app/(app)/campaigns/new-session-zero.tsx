"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewSessionZeroButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sz", { method: "POST" });
      const body = (await res.json()) as { campaignId?: string; error?: string };
      if (!res.ok || !body.campaignId) throw new Error(body.error ?? "could not begin");
      router.push(`/sz/${body.campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not begin");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={begin}
        disabled={busy}
        className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Opening the studio…" : "Begin Session Zero"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
