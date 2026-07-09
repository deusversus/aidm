import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, episodicRecords, turns } from "@/lib/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PlayView } from "./play-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The play view (§9.1): streaming prose, staging progress, decision
 * points, typed errors with retry, queued input. The transcript
 * rehydrates from the episodic layer — the durable record IS the UI state.
 */
export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
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

  const recent = await db
    .select({
      turnNumber: episodicRecords.turnNumber,
      playerInput: episodicRecords.playerInput,
      narration: episodicRecords.narration,
    })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, id), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(12);

  // An open turn (in-flight, or failed awaiting retry) resumes on load.
  const [openTurn] = await db
    .select({ id: turns.id, status: turns.status, playerInput: turns.playerInput })
    .from(turns)
    .where(
      and(
        eq(turns.campaignId, id),
        inArray(turns.status, ["queued", "phase_a_complete", "phase_b_complete", "failed"]),
      ),
    )
    .orderBy(asc(turns.turnNumber))
    .limit(1);

  const contract = campaign.premiseContract as { suggestion_affordance?: string } | null;

  return (
    <PlayView
      campaignId={id}
      title={campaign.title}
      initialExchanges={[...recent].reverse()}
      openTurn={openTurn ?? null}
      suggestionAffordance={contract?.suggestion_affordance ?? "on_request_only"}
    />
  );
}
