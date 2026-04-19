import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/state/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

export const runtime = "nodejs";

export default async function CampaignsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

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
            <li key={c.id}>
              <Link
                href={`/campaigns/${c.id}/play`}
                className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/40"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground text-xs uppercase tracking-wider">
                  {c.phase}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
