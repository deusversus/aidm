import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { runConductorTurn } from "@/lib/sz/conductor";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A conductor turn can span a research_title call (~30-90s of scraping +
// synthesis) plus multiple narration rounds.
export const maxDuration = 300;

/**
 * One conductor turn, streamed as SSE: `text` deltas, `staging` progress,
 * `ready_to_compile`, then `done` (or `error`). Empty message = the kickoff
 * turn — the conductor speaks first (§8).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (campaign.status !== "draft") {
    return NextResponse.json({ error: "session zero is closed on this campaign" }, { status: 409 });
  }

  const { message } = (await req.json().catch(() => ({}))) as { message?: string };

  const encoder = new TextEncoder();
  // A dropped client (reload, closed tab) must NOT kill the turn: the
  // conversation is durable, the transport is not. Once the controller is
  // gone, emits become no-ops and the turn runs to completion + persist;
  // the reloaded page finds it via the resume flow.
  let open = true;
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
      try {
        const draft = await runConductorTurn(db, id, message ?? "", (e) => send(e.type, e));
        send("done", { readyToCompile: draft.readyToCompile });
      } catch (err) {
        console.error("[sz/turn] conductor turn failed", err);
        send("error", { message: err instanceof Error ? err.message : "conductor turn failed" });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // already closed by the client side
          }
        }
      }
    },
    cancel() {
      open = false;
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
