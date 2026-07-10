import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewSessionZeroButton } from "./new-session-zero";
import { ShelfActions } from "./shelf-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShelfRow = { id: string; title: string; status: string };

/**
 * The campaign shelf (§9.1): the player's campaigns grouped by state. Active
 * campaigns open the play view; drafts resume Session Zero; archived
 * campaigns tuck into a collapsed, subdued section (their link still opens
 * play, which shows the archived notice until they unarchive). Soft-deleted
 * campaigns are never listed. Per-row archive/unarchive/delete controls live
 * in the client ShelfActions.
 */
export default async function CampaignsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const rows = await getDb()
    .select({
      id: campaigns.id,
      title: campaigns.title,
      status: campaigns.status,
    })
    .from(campaigns)
    .where(and(eq(campaigns.playerId, user.id), ne(campaigns.status, "deleted")))
    .orderBy(desc(campaigns.updatedAt));

  const active = rows.filter((c) => c.status === "active");
  const drafts = rows.filter((c) => c.status === "draft" || c.status === "compiling");
  const archived = rows.filter((c) => c.status === "archived");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Signed in{user.email ? ` as ${user.email}` : ""}.
        </p>
      </div>

      <NewSessionZeroButton />

      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No campaigns yet — begin Session Zero to start one.
        </p>
      )}

      {active.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Active</h2>
          <ShelfList rows={active} hrefFor={(id) => `/play/${id}`} />
        </section>
      )}

      {drafts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Drafts</h2>
          <ShelfList rows={drafts} hrefFor={(id) => `/sz/${id}`} />
        </section>
      )}

      {archived.length > 0 && (
        <details className="opacity-70">
          <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground/60">
            Archived · {archived.length}
          </summary>
          <div className="mt-2">
            <ShelfList rows={archived} hrefFor={(id) => `/play/${id}`} />
          </div>
        </details>
      )}
    </main>
  );
}

function ShelfList({ rows, hrefFor }: { rows: ShelfRow[]; hrefFor: (id: string) => string }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <Link
            href={hrefFor(c.id)}
            className="flex flex-1 items-center justify-between gap-3 text-sm hover:opacity-80"
          >
            <span className="font-medium">{c.title}</span>
            <span className="text-xs text-muted-foreground">{statusLabel(c.status)}</span>
          </Link>
          <ShelfActions campaignId={c.id} status={c.status} />
        </li>
      ))}
    </ul>
  );
}

function statusLabel(status: string): string {
  if (status === "draft") return "Session Zero in progress";
  if (status === "compiling") return "compiling…";
  return status;
}
