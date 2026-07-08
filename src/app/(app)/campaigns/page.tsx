import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NewSessionZeroButton } from "./new-session-zero";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin shelf: drafts resume Session Zero; active campaigns wait on the
// play view (C5). The full §9.1 shelf treatment is M4's studio pass.
export default async function CampaignsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const rows = await getDb()
    .select({
      id: campaigns.id,
      title: campaigns.title,
      status: campaigns.status,
      updatedAt: campaigns.updatedAt,
    })
    .from(campaigns)
    .where(eq(campaigns.playerId, user.id))
    .orderBy(desc(campaigns.updatedAt));

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Signed in{user.email ? ` as ${user.email}` : ""}.
        </p>
      </div>

      <NewSessionZeroButton />

      {rows.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={c.status === "draft" ? `/sz/${c.id}` : `/play/${c.id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-muted"
              >
                <span className="font-medium">{c.title}</span>
                <span className="text-xs text-muted-foreground">
                  {c.status === "draft" ? "Session Zero in progress" : c.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
