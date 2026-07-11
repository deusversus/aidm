import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { type ConductorDraft, draftMessages, emptyDraft } from "@/lib/sz/conductor";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Session Zero transcript reader (§8): once a campaign activates the live
 * SZ view redirects away, but the conversation that set the table is kept on
 * campaigns.szTranscript. This is its read-only home — the studio's record of
 * what it heard, always reachable from the shelf.
 */
export default async function SzTranscriptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) notFound();

  const draft = (campaign.szTranscript as ConductorDraft | null) ?? emptyDraft();
  const messages = draftMessages(draft);
  const observations = draft.observations ?? [];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-16">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Session Zero</h1>
        <p className="text-sm text-muted-foreground">
          {campaign.title} — the conversation that set the table.
        </p>
        <Link href="/campaigns" className="text-sm underline underline-offset-4">
          ← Back to campaigns
        </Link>
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Session Zero transcript recorded.</p>
      ) : (
        <div className="space-y-5">
          {messages.map((m, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static append-only transcript
              key={i}
              className="space-y-1"
            >
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
                {m.role === "player" ? "You" : "Conductor"}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-7">{m.text}</p>
            </div>
          ))}
        </div>
      )}

      {observations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
            Recorded
          </h2>
          <ul className="space-y-1">
            {observations.map((o, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static append-only list
                key={i}
                className="text-sm leading-6"
              >
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
                  {o.kind}
                </span>
                <span className="ml-2 text-muted-foreground">{o.content}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
