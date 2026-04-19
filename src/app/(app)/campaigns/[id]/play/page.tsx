import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, turns } from "@/lib/state/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import PlayUI from "./play-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PlayPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const db = getDb();

  const [campaign] = await db
    .select({ id: campaigns.id, name: campaigns.name, userId: campaigns.userId })
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) notFound();

  const priorTurns = await db
    .select({
      turn_number: turns.turnNumber,
      player_message: turns.playerMessage,
      narrative_text: turns.narrativeText,
    })
    .from(turns)
    .where(eq(turns.campaignId, id))
    .orderBy(asc(turns.turnNumber));

  return <PlayUI campaignId={campaign.id} campaignName={campaign.name} priorTurns={priorTurns} />;
}
