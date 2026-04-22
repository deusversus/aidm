import { getBudgetSnapshot } from "@/lib/budget";
import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SpendingForm } from "./spending-form";

export const dynamic = "force-dynamic";

/**
 * /account/spending — minimal single-field page where the user sets
 * (or clears) their daily cost cap (Commit 9).
 *
 * The cap is a user-level guardrail, not campaign-scoped. The business
 * model is cost-forward + markup on owned provider keys
 * (project_business_model.md) — users pay for what they use, and the
 * cap is THEIR ceiling (default = no cap). Setting cap = 0 is a
 * legitimate "zero-spend day" choice, distinct from null (no cap).
 */
export default async function SpendingPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const snapshot = await getBudgetSnapshot(user.id);

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="mb-6">
        <Link href="/campaigns" className="text-muted-foreground text-sm hover:text-foreground">
          ← back to campaigns
        </Link>
      </div>
      <h1 className="mb-2 font-semibold text-2xl tracking-tight">Daily spending cap</h1>
      <p className="mb-6 text-muted-foreground text-sm">
        Set a personal daily ceiling so a runaway loop or a long session can't accidentally spend
        past what you intended. The system doesn't impose a default cap — you're paying for what you
        use, and this is your guardrail. Clear it anytime to remove the ceiling.
      </p>

      <div className="mb-6 rounded-lg border bg-background/40 p-4 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">Today's spend (UTC)</span>
          <span className="tabular-nums font-medium">${snapshot.usedUsd.toFixed(4)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-muted-foreground">Current cap</span>
          <span className="tabular-nums font-medium">
            {snapshot.capUsd === null ? "no cap" : `$${snapshot.capUsd.toFixed(2)}`}
          </span>
        </div>
        {snapshot.capUsd !== null && snapshot.percent !== null ? (
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-muted-foreground">Usage</span>
            <span className="tabular-nums font-medium">{Math.round(snapshot.percent * 100)}%</span>
          </div>
        ) : null}
      </div>

      <SpendingForm initialCap={snapshot.capUsd} />

      <p className="mt-4 text-muted-foreground text-xs">
        The cap resets at UTC midnight
        {snapshot.nextResetAt
          ? ` (next reset: ${new Date(snapshot.nextResetAt).toLocaleString()})`
          : ""}
        . Rate limiting (turns-per-minute) is a separate system-level guard that always runs.
      </p>
    </div>
  );
}
