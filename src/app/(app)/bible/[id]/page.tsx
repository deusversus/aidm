import { getCurrentUser } from "@/lib/auth";
import { type BibleEntry, composeBible } from "@/lib/bible/bible";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Series Bible (§9.1): the Premise Contract + cast + world facts + spark,
 * typeset as a living production document — read-only at M1. Auth + ownership
 * + status guard mirror the play view; the bible reveals only after the cold
 * open lands (composeBible's reveal gate), teasing before it.
 */
export default async function BiblePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) notFound();
  if (campaign.status === "draft" || campaign.status === "compiling") redirect(`/sz/${id}`);
  if (campaign.status !== "active") {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.title}</h1>
        <p className="text-sm text-muted-foreground">This campaign is {campaign.status}.</p>
        <Link href="/campaigns" className="text-sm underline underline-offset-4">
          ← Back to campaigns
        </Link>
      </main>
    );
  }

  const bible = await composeBible(db, id);
  if (!bible) notFound();

  if (!bible.revealed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
        <p className="max-w-md text-balance text-lg italic leading-8 text-muted-foreground">
          The bible is written as the story is lived — return after the first scene.
        </p>
        <Link href={`/play/${id}`} className="text-sm underline underline-offset-4">
          ← Back to the story
        </Link>
      </main>
    );
  }

  const { premise } = bible;
  const hasWorldLine = Boolean(premise.worldName || premise.powerSystem);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-10 px-6 py-16">
      <header className="space-y-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
          the series bible
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{bible.title}</h1>
      </header>

      <section className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">the spark</p>
        <blockquote className="border-l-2 border-foreground/40 pl-4 text-lg italic leading-8">
          “{bible.spark}”
        </blockquote>
      </section>

      <section className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">premise</p>
        <dl className="space-y-3 text-sm">
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Finitude</dt>
            <dd className="leading-6">{FINITUDE_LINE[premise.finitude] ?? premise.finitude}</dd>
          </div>
          {hasWorldLine && (
            <div className="space-y-0.5">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">World</dt>
              <dd className="leading-6">
                {[premise.worldName, premise.powerSystem].filter(Boolean).join(" — ")}
              </dd>
            </div>
          )}
        </dl>
        {premise.hardLines.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Hard lines — absolute, no dice
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm leading-6">
              {premise.hardLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <BibleSection title="Cast" entries={bible.cast} />
      <BibleSection title="Factions" entries={bible.factions} />
      <BibleSection title="Locations" entries={bible.locations} />
      <BibleSection title="Threads" entries={bible.threads} />

      {bible.worldFacts.length > 0 && (
        <section className="space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
            world facts
          </p>
          <ul className="space-y-2 text-sm leading-6">
            {bible.worldFacts.map((f) => (
              <li key={f.content} className="flex items-start gap-2">
                <span>{f.content}</span>
                {f.playerMinted && <PlayerBadge />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href={`/play/${id}`} className="text-sm underline underline-offset-4">
        ← Back to the story
      </Link>
    </main>
  );
}

const FINITUDE_LINE: Record<string, string> = {
  finite: "This story ends — the studio builds quietly toward a planned finale.",
  indefinite: "An open cycle — the studio never forces an ending.",
  undecided: "Undecided — revisited at each season's turn, never settled unilaterally.",
};

function BibleSection({ title, entries }: { title: string; entries: BibleEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className="space-y-3">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">{title}</p>
      <div className="space-y-4">
        {entries.map((e) => (
          <div key={e.name} className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{e.name}</h3>
              {e.playerMinted && <PlayerBadge />}
            </div>
            {e.block && (
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {e.block}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerBadge() {
  return (
    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      player-authored
    </span>
  );
}
