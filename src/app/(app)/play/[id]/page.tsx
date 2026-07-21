import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, episodicRecords, turns } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { DirectiveGrant } from "@/lib/types/premise";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
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

  // §5.5 degraded markers rehydrate with the transcript (M2R R3 — the flag
  // was a dead SSE wire; a reload hid which scenes rendered thin).
  const degradedRows = await db
    .select({ turnNumber: turns.turnNumber })
    .from(turns)
    .where(and(eq(turns.campaignId, id), eq(turns.degraded, true)));
  const degradedSet = new Set(degradedRows.map((r) => r.turnNumber));

  // Channel turns live OUTSIDE the episodic layer by design (§5.4 — booth
  // text never enters the story window), so the transcript rehydrates them
  // from the turns table; their replay metadata rides the sidecar jsonb (C9).
  const channelRows = await db
    .select({
      turnNumber: turns.turnNumber,
      playerInput: turns.playerInput,
      narration: turns.narration,
      sidecar: turns.sidecar,
    })
    .from(turns)
    .where(and(eq(turns.campaignId, id), eq(turns.status, "channel")))
    .orderBy(desc(turns.turnNumber))
    .limit(12);
  const channelItems = channelRows.map((t) => {
    const meta = (t.sidecar ?? {}) as {
      channel?: string;
      responder?: "director" | "ka";
      closed?: boolean;
      acknowledgement?: string;
    };
    return {
      kind: "channel" as const,
      turnNumber: t.turnNumber,
      playerInput: t.playerInput,
      narration: t.narration ?? "",
      intent: (meta.channel ?? "META_FEEDBACK") as
        | "META_FEEDBACK"
        | "OVERRIDE_COMMAND"
        | "OP_COMMAND",
      ...(meta.responder ? { responder: meta.responder } : {}),
      ...(meta.closed !== undefined ? { closed: meta.closed } : {}),
      ...(meta.acknowledgement ? { acknowledgement: meta.acknowledgement } : {}),
    };
  });
  const initialItems = [
    ...recent.map((r) => ({
      kind: "story" as const,
      ...r,
      ...(degradedSet.has(r.turnNumber) ? { degraded: true } : {}),
    })),
    ...channelItems,
  ]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .slice(-16);

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

  const contract = campaign.premiseContract as {
    suggestion_affordance?: string;
    presentation_vocabulary?: { directives?: unknown };
  } | null;
  const affordance = contract?.suggestion_affordance ?? "on_request_only";
  // M3-DG: the premise's granted display devices ride to every prose surface
  // (zod-parsed — a malformed grant degrades to no chrome, never a crash).
  const parsedDirectives = z
    .array(DirectiveGrant)
    .safeParse(contract?.presentation_vocabulary?.directives ?? []);
  const displayDirectives = parsedDirectives.success ? parsedDirectives.data : [];

  // §4.5 M2R3 steering-honesty notice: a player-driven drift the Director
  // answered with an evolution. Read the flag off direction_state; the play
  // view shows one quiet dismissible line and clears it via the DELETE route.
  const steeringNotice =
    (
      campaign.directionState as {
        steering_notice?: { axis: string; observed: number; set: number };
      } | null
    )?.steering_notice ?? null;

  // §9.2 chips rehydration (M2R R1): the durable record IS the UI state — a
  // reload over a live decision point re-offers the KA's persisted moves.
  // Only when no turn is open (an open turn means a new scene supersedes).
  let initialChips: string[] | undefined;
  if (!openTurn && affordance === "default_on") {
    const [lastComplete] = await db
      .select({ sidecar: turns.sidecar })
      .from(turns)
      .where(and(eq(turns.campaignId, id), eq(turns.status, "complete")))
      .orderBy(desc(turns.turnNumber))
      .limit(1);
    const sidecar = lastComplete?.sidecar as {
      decision_point?: boolean;
      suggested_moves?: string[];
    } | null;
    // Same gate as the suggestions route (audit): 2-3 moves, never more.
    if (sidecar?.decision_point && (sidecar.suggested_moves?.length ?? 0) >= 2) {
      initialChips = sidecar.suggested_moves?.slice(0, 3);
    }
  }

  return (
    <PlayView
      campaignId={id}
      title={campaign.title}
      initialExchanges={initialItems}
      openTurn={openTurn ?? null}
      suggestionAffordance={affordance}
      {...(initialChips ? { initialChips } : {})}
      {...(steeringNotice ? { steeringNotice } : {})}
      displayDirectives={displayDirectives}
      // §9.5 voice: present only when the key is configured — no key, no button.
      ttsAvailable={Boolean(process.env.ELEVENLABS_API_KEY)}
      ttsVoiceId={
        (campaign.voiceSettings as { voice_id?: string } | null)?.voice_id ??
        env.ELEVENLABS_VOICE_ID
      }
    />
  );
}
