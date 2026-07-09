import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { type ConductorDraft, draftMessages, emptyDraft } from "@/lib/sz/conductor";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SzChat } from "./sz-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Session Zero (§8): the one conductor conversation, resumable across
 * sittings — the draft rehydrates server-side on every load.
 */
export default async function SessionZeroPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) notFound();

  // 'compiling' = a compile crashed mid-flight; the chat view's compile
  // button re-claims it, so the conversation stays reachable.
  if (campaign.status !== "draft" && campaign.status !== "compiling") {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.title}</h1>
        <p className="text-sm text-muted-foreground">
          Session Zero is complete — the table is set. The play view lands with C5.
        </p>
        <Link href="/campaigns" className="text-sm underline underline-offset-4">
          ← Back to campaigns
        </Link>
      </main>
    );
  }

  const draft = (campaign.szTranscript as ConductorDraft | null) ?? emptyDraft();

  return (
    <SzChat
      campaignId={id}
      initialMessages={draftMessages(draft)}
      initialReady={draft.readyToCompile}
    />
  );
}
