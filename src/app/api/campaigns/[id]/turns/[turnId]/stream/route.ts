import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns, turns } from "@/lib/db/schema";
import { attachToTurn, executeTurn, isRunning } from "@/lib/turn/runtime";
import type { CommitScene } from "@/lib/types/sidecar";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE progress stream for a turn (§5.7): a reconnect finds the turn
 * complete (replayed as one chunk) or in-progress (attached live). An
 * orphaned in-progress turn — crashed executor — is resumed from its
 * checkpoints right here: the reconnect IS the recovery path.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id, turnId } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [turn] = await db
    .select()
    .from(turns)
    .where(and(eq(turns.id, turnId), eq(turns.campaignId, id)));
  if (!turn) return NextResponse.json({ error: "not found" }, { status: 404 });

  const encoder = new TextEncoder();
  let open = true;
  let detach: (() => void) | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };

      if (turn.status === "complete" || turn.status === "channel" || turn.status === "failed") {
        // Replay: the durable record is the source of truth.
        if (turn.narration) send("prose", { text: turn.narration });
        if (turn.status === "failed") {
          send("error", {
            message:
              "The scene failed to render twice. Your action is saved — retry when ready; the dice stay as they fell.",
            retryable: true,
          });
        } else if (turn.status === "channel") {
          // Channel replay metadata rides the sidecar jsonb (§5.4, C9):
          // {channel: intent, responder?, closed?, acknowledgement?}.
          const meta = (turn.sidecar ?? {}) as {
            channel?: string;
            responder?: string;
            closed?: boolean;
            acknowledgement?: string;
          };
          send("channel", {
            intent: meta.channel ?? "META_FEEDBACK",
            ...(meta.responder ? { responder: meta.responder } : {}),
            ...(meta.closed !== undefined ? { closed: meta.closed } : {}),
            ...(meta.acknowledgement ? { acknowledgement: meta.acknowledgement } : {}),
          });
        } else {
          const sidecar = turn.sidecar as CommitScene | null;
          send("done", {
            turnNumber: turn.turnNumber,
            decisionPoint: sidecar?.decision_point ?? false,
            suggestedMoves: sidecar?.suggested_moves ?? [],
            degraded: turn.degraded,
          });
        }
        close();
        return;
      }

      detach = attachToTurn(turnId, (e) => {
        send(e.type, e);
        if (e.type === "done" || e.type === "error" || e.type === "channel") close();
      });

      // Orphaned turn (crash before this reconnect): resume from checkpoints.
      if (!isRunning(turnId)) {
        void executeTurn(db, turnId).catch((err) => {
          console.error("[stream] resume execution crashed", { turnId, err });
          send("error", { message: "the turn crashed — retry when ready", retryable: true });
          close();
        });
      }
    },
    cancel() {
      open = false;
      detach?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
