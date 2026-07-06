import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureUserSeeded } from "@/lib/seed/ensure-seeded";
import { campaigns } from "@/lib/state/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  // Backfill users-row + Bebop campaign for accounts that slipped past
  // the Clerk webhook. Idempotent — fresh webhook-seeded users no-op
  // through here. See src/lib/seed/ensure-seeded.ts for rationale.
  try {
    await ensureUserSeeded(user);
  } catch (err) {
    console.error("ensureUserSeeded failed on /campaigns load", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const rows = await getDb()
    .select({ id: campaigns.id, name: campaigns.name, phase: campaigns.phase })
    .from(campaigns)
    .where(and(eq(campaigns.userId, user.id), isNull(campaigns.deletedAt)))
    .orderBy(desc(campaigns.createdAt));

  const greeting = user.email ?? user.id;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">hello, {greeting}</h1>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          Your campaign is still being seeded. Refresh in a moment — the Bebop demo campaign should
          appear shortly after your first sign-in.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li
              key={c.id}
              className="flex items-stretch gap-2 rounded-lg border hover:border-foreground/20"
            >
              <Link
                href={`/campaigns/${c.id}/play`}
                className="flex flex-1 items-center justify-between p-4 hover:bg-muted/40"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground text-xs uppercase tracking-wider">
                  {c.phase}
                </span>
              </Link>
              <Link
                href={`/campaigns/${c.id}/settings`}
                className="flex items-center border-l px-4 text-muted-foreground text-xs hover:bg-muted/40 hover:text-foreground"
                aria-label={`Settings for ${c.name}`}
              >
                settings
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
