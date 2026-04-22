import { checkBudget, incrementCostLedger } from "@/lib/budget";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/state/schema";
import { CampaignSettings } from "@/lib/types/campaign-settings";
import { chronicleTurn, computeArcTrigger } from "@/lib/workflow/chronicle";
import { runMeta, shouldDispatchMeta } from "@/lib/workflow/meta";
import { runTurn } from "@/lib/workflow/turn";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, after } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn endpoint — SSE stream of KA's narrative for one player input.
 *
 * Protocol: standard text/event-stream. Each SSE event carries JSON:
 *   event: routed   → data: { verdictKind, response, turnNumber }
 *   event: text     → data: { delta }
 *   event: done     → data: { turnId, turnNumber, narrative, ttftMs, totalMs,
 *                             costUsd, portraitNames, verdictKind, intent, outcome }
 *   event: error    → data: { message }
 *
 * The `done` payload's verdictKind + intent + outcome fields were added in
 * Commit 7.4 so the route handler can fire Chronicler via `after()` with
 * full context. The browser client currently ignores them (typed in
 * src/hooks/use-turn-stream.ts without the new fields) — extending the
 * client type is a low-value follow-up if the UI ever needs type-safe
 * access.
 *
 * Client closes when it sees `done` or `error`. If the fetch is aborted
 * mid-stream (user navigates away, clicks stop), the AbortController
 * fires and KA's Agent SDK subprocess is torn down.
 */

const PostBody = z.object({
  campaignId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  // Pre-turn budget gate (Commit 9). Runs BEFORE opening the SSE stream
  // so we can return an honest 429 + JSON body; encoding a gate-rejection
  // as an SSE error event on a 200 stream would be misleading to the
  // client. `checkBudget` does the cost-cap check first (non-mutating),
  // then atomically increments the rate counter and compares — that
  // ordering is what closes the TOCTOU gap a read-then-increment pattern
  // would leave under concurrent POSTs.
  const gate = await checkBudget(user.id);
  if (!gate.ok) {
    if (gate.reason === "rate") {
      return NextResponse.json(
        {
          error: "rate_limited",
          reason: "rate",
          retryAfterSec: gate.retryAfterSec,
          rateCount: gate.rateCount,
          rateCap: gate.rateCap,
        },
        {
          status: 429,
          headers: { "Retry-After": String(gate.retryAfterSec) },
        },
      );
    }
    // cost_cap
    return NextResponse.json(
      {
        error: "cost_cap_reached",
        reason: "cost_cap",
        usedUsd: gate.usedUsd,
        capUsd: gate.capUsd,
        nextResetAt: gate.nextResetAt,
      },
      { status: 429 },
    );
  }

  const abort = new AbortController();
  // Forward client disconnect to KA's subprocess.
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Prime the connection through Railway's reverse proxy. Small
      // SSE streams (router short-circuit path: ~2 tiny events, no
      // token-deltas in between) can sit buffered upstream until the
      // stream closes, so the client sees nothing live and events
      // only surface via DB-backed page refresh. Sending a leading
      // comment line with padding immediately flushes through any
      // buffer threshold. Comment lines (`:<text>\n`) are ignored by
      // SSE parsers per the spec.
      controller.enqueue(new TextEncoder().encode(`: stream open${" ".repeat(2048)}\n\n`));

      try {
        const db = getDb();

        // Phase 5 meta-conversation dispatch. Pre-parse for slash
        // commands + check in-flight meta state; route to runMeta when
        // appropriate, runTurn otherwise. The DB lookup is cheap and
        // bounded; avoids a full runTurn round-trip for meta exchanges.
        const [campaignRow] = await db
          .select({ settings: campaigns.settings })
          .from(campaigns)
          .where(
            and(
              eq(campaigns.id, body.campaignId),
              eq(campaigns.userId, user.id),
              isNull(campaigns.deletedAt),
            ),
          )
          .limit(1);
        const parsed = CampaignSettings.safeParse(campaignRow?.settings ?? {});
        const metaState = parsed.success ? parsed.data.meta_conversation : undefined;

        // If the player resumed with a suffix, consume it as the turn
        // message. Drop the meta state first so runTurn sees a clean
        // game state.
        if (shouldDispatchMeta(body.message, metaState)) {
          const metaIter = runMeta(
            {
              campaignId: body.campaignId,
              userId: user.id,
              playerMessage: body.message,
            },
            { db },
          );
          let pendingResumeSuffix: string | undefined;
          for await (const ev of metaIter) {
            const { type, ...rest } = ev;
            controller.enqueue(encodeSseEvent(type, rest));
            if (type === "exited") pendingResumeSuffix = ev.pendingResumeSuffix;
          }
          // If /resume had a suffix, fall through to runTurn with the
          // suffix as the gameplay message. Otherwise emit a distinct
          // `meta_done` terminal event so the client knows the meta
          // exchange concluded WITHOUT committing a phantom turn_number=0
          // row to the gameplay feed. The gameplay `done` event is
          // reserved for real turns that advance the turn counter.
          if (pendingResumeSuffix) {
            // Intentional fallthrough — continue to runTurn below.
            body.message = pendingResumeSuffix;
          } else {
            controller.enqueue(encodeSseEvent("meta_done", {}));
            controller.close();
            return;
          }
        }

        // Pre-turn gate ran before this stream opened. The HTTP route
        // cannot skip the gate — checkBudget is unconditional above,
        // and the request body schema doesn't accept any override field.
        const iter = runTurn(
          {
            campaignId: body.campaignId,
            userId: user.id,
            playerMessage: body.message,
            abort,
          },
          { db },
        );
        for await (const ev of iter) {
          const { type, ...rest } = ev;
          controller.enqueue(encodeSseEvent(type, rest));
          if (type === "done") {
            // Post-turn cost ledger increment (Commit 9). Adds the
            // PRE-CHRONICLER turn cost into user_cost_ledger[user, today].
            // Chronicler's cost is added separately inside chronicleTurn
            // when it finishes (it can trail the done event by seconds).
            // Wrapped in try/catch — a ledger failure must not fail a
            // turn the user already saw; log + continue.
            if (typeof ev.costUsd === "number" && ev.costUsd > 0) {
              try {
                await incrementCostLedger(user.id, ev.costUsd);
              } catch (err) {
                console.warn("post-turn incrementCostLedger failed", {
                  userId: user.id,
                  costUsd: ev.costUsd,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            // Fire Chronicler post-response via Next's after(). It runs
            // after the SSE response has flushed to the client — user-
            // perceived latency is unchanged. FIFO-per-campaign lock +
            // idempotency guard are both inside chronicleTurn.
            //
            // Chronicle on `continue` (player-driven narrative) AND
            // `worldbuilder` (player-asserted canon). WB short-circuits
            // already persisted entity updates synchronously inside the
            // turn workflow; Chronicler adds the episodic summary,
            // spotlight-debt maintenance, and voice-patterns observation
            // that apply equally to WB turns. META / OVERRIDE skip
            // chronicling — their structured effects are the whole point
            // of the turn; no narrative to catalog.
            if (ev.verdictKind === "continue" || ev.verdictKind === "worldbuilder") {
              const chronicleInput = {
                turnId: ev.turnId,
                campaignId: body.campaignId,
                userId: user.id,
                turnNumber: ev.turnNumber,
                playerMessage: body.message,
                narrative: ev.narrative,
                intent: ev.intent,
                outcome: ev.outcome,
                arcTrigger: computeArcTrigger(ev.intent.epicness, ev.turnNumber),
              };
              after(async () => {
                await chronicleTurn(chronicleInput, { db });
              });
            }
            break;
          }
          if (type === "error") break;
        }
      } catch (err) {
        controller.enqueue(
          encodeSseEvent("error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Explicit identity encoding — blocks any upstream gzip/deflate
      // that would batch tiny SSE payloads before sending. Pairs with
      // the padding priming comment above for a belt-and-suspenders
      // anti-buffering posture.
      "Content-Encoding": "identity",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
