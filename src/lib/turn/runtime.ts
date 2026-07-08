import { assembleForCampaign } from "@/lib/blocks/campaign";
import type { Db } from "@/lib/db";
import { campaigns, episodicRecords, turns } from "@/lib/db/schema";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { Conte } from "@/lib/types/conte";
import type { CommitScene } from "@/lib/types/sidecar";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { LadderStep } from "./degrade";
import { runKeyAnimator } from "./ka";
import { runLayout } from "./layout";

/**
 * The Turn Runtime (blueprint §5.7): turns are durable server-side jobs.
 * A submitted input runs to completion regardless of the client; the
 * executor is RE-ENTRANT over per-step checkpoint markers, so a crash (or
 * a reconnect finding an orphaned turn) resumes from the last completed
 * phase — Phase-B retries reuse the checkpointed conte: same dice, same
 * spends. Single-instance execution assumed (solo player, one Railway
 * replica); the in-process registry is the double-run guard.
 */

export type TurnEvent =
  | { type: "staging"; text: string }
  | { type: "prose"; text: string }
  | { type: "reset" } // Phase-B retry: client discards streamed partials
  | {
      type: "done";
      turnNumber: number;
      decisionPoint: boolean;
      suggestedMoves: string[];
      degraded: boolean;
    }
  | { type: "channel"; intent: string }
  | { type: "error"; message: string; retryable: boolean };

interface BusEntry {
  listeners: Set<(e: TurnEvent) => void>;
  buffer: TurnEvent[];
  /** Bumped on every terminal event; the cleanup timer no-ops if it changed. */
  generation: number;
}

const bus = new Map<string, BusEntry>();
const running = new Set<string>();

function ensureEntry(turnId: string): BusEntry {
  let entry = bus.get(turnId);
  if (!entry) {
    entry = { listeners: new Set(), buffer: [], generation: 0 };
    bus.set(turnId, entry);
  }
  return entry;
}

/**
 * A fresh run (initial or retry) discards any stale buffer so a re-attaching
 * client never replays a PRIOR run's terminal event (e.g. an old 'error'
 * that would close a retry stream on sight). Listeners persist — a client
 * may already be attached and waiting.
 */
function resetBuffer(turnId: string) {
  const entry = bus.get(turnId);
  if (entry) entry.buffer = [];
}

function publish(turnId: string, event: TurnEvent) {
  const entry = ensureEntry(turnId);
  entry.buffer.push(event);
  for (const l of entry.listeners) l(event);
  if (event.type === "done" || event.type === "error" || event.type === "channel") {
    // Terminal: drop the entry after a grace window — but only if no newer
    // run has published since (generation guard) and nothing is running, so
    // a retry started inside the window is never orphaned.
    entry.generation += 1;
    const gen = entry.generation;
    setTimeout(() => {
      const e = bus.get(turnId);
      if (e && e.generation === gen && !running.has(turnId)) bus.delete(turnId);
    }, 60_000).unref?.();
  }
}

/** Attach a listener; replays buffered events first. Returns detach. */
export function attachToTurn(turnId: string, listener: (e: TurnEvent) => void): () => void {
  const entry = ensureEntry(turnId);
  for (const e of entry.buffer) listener(e);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function isRunning(turnId: string): boolean {
  return running.has(turnId);
}

export class TurnInProgressError extends Error {
  constructor(public readonly pendingTurnId: string) {
    super("a turn is already in progress on this campaign");
  }
}

// 'failed' stays open: submitting past a failed turn would let a later
// retry interleave the episodic record. The retry affordance is the way
// forward (§5.7); discard-a-turn arrives with C6's rewind.
const OPEN_STATUSES = ["queued", "phase_a_complete", "phase_b_complete", "failed"];

/**
 * Enqueue a turn (§5.7): allocates the next turn number, persists the job,
 * kicks the executor detached, returns immediately. A campaign runs ONE
 * turn at a time — a second submit while one is open throws
 * TurnInProgressError (the client queues; §5.7's pending state).
 */
export async function submitTurn(
  db: Db,
  campaignId: string,
  playerInput: string,
): Promise<{ turnId: string; turnNumber: number }> {
  const [open] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, campaignId), inArray(turns.status, OPEN_STATUSES)))
    .limit(1);
  if (open) throw new TurnInProgressError(open.id);

  const [last] = await db
    .select({ n: turns.turnNumber })
    .from(turns)
    .where(eq(turns.campaignId, campaignId))
    .orderBy(desc(turns.turnNumber))
    .limit(1);
  const turnNumber = (last?.n ?? 0) + 1;

  const [row] = await db
    .insert(turns)
    .values({ campaignId, turnNumber, tier: "genga", status: "queued", playerInput })
    .returning({ id: turns.id });
  if (!row) throw new Error("turn enqueue failed");

  void executeTurn(db, row.id).catch((err) => {
    console.error("[runtime] detached turn execution crashed", { turnId: row.id, err });
  });
  return { turnId: row.id, turnNumber };
}

/**
 * The re-entrant executor: Layout → KA → G1-minimal, each behind a
 * checkpoint marker. Safe to call again on a turn that crashed mid-flight
 * (reconnect path does exactly that); a turn already running in-process
 * is left alone.
 */
export async function executeTurn(db: Db, turnId: string): Promise<void> {
  if (running.has(turnId)) return;
  running.add(turnId);
  // Fresh run: any buffered terminal event belongs to a prior (failed) run.
  resetBuffer(turnId);
  try {
    await executeTurnInner(db, turnId);
  } finally {
    running.delete(turnId);
  }
}

/** Terminal statuses the executor never re-runs (guards a stale-status race). */
const TERMINAL_STATUSES = new Set(["complete", "channel", "failed"]);

async function executeTurnInner(db: Db, turnId: string): Promise<void> {
  const [turn] = await db.select().from(turns).where(eq(turns.id, turnId));
  if (!turn) throw new Error("turn not found");
  // A terminal turn is never re-run: a retry moves status OFF 'failed' first,
  // so this guard closes the stream-route stale-status window (a third,
  // unsanctioned attempt on an already-failed turn) without blocking retries.
  if (TERMINAL_STATUSES.has(turn.status)) return;
  const emit = (e: TurnEvent) => publish(turnId, e);
  try {
    await runPhases(db, turnId, turn, emit);
  } catch (err) {
    // Uncaught failure OUTSIDE the Phase-B retry loop (Phase A, block
    // assembly, G1 write). §5.7/§9.1: never a silent hang — mark failed,
    // surface a typed retryable error. Resume re-runs from the last
    // checkpoint (Phase A re-rolls fresh; nothing was committed).
    console.error("[runtime] turn failed outside Phase B", { turnId, err });
    await db
      .update(turns)
      .set({
        status: "failed",
        checkpoints: sql`${turns.checkpoints} || ${JSON.stringify({ error: String(err) })}::jsonb`,
      })
      .where(eq(turns.id, turnId));
    emit({
      type: "error",
      message:
        "The scene hit a snag before it could render. Your action is saved — retry when ready.",
      retryable: true,
    });
  }
}

type TurnRow = typeof turns.$inferSelect;

async function runPhases(
  db: Db,
  turnId: string,
  turn: TurnRow,
  emit: (e: TurnEvent) => void,
): Promise<void> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, turn.campaignId));
  if (!campaign) throw new Error("campaign not found");
  const parsedSelection = TierSelection.safeParse(campaign.tierModels);
  const selection = parsedSelection.success ? parsedSelection.data : DEV_TIER_SELECTION;
  const checkpoints = (turn.checkpoints ?? {}) as {
    phase_a?: boolean;
    phase_b?: boolean;
    g1?: boolean;
    ladder?: LadderStep[];
    trailer_fallback?: boolean;
    error?: string;
  };

  // --- Phase A (checkpointed by runLayout itself) ----------------------------
  let conte: Conte;
  let ladderSteps: LadderStep[] = checkpoints.ladder ?? [];
  if (!checkpoints.phase_a) {
    const result = await runLayout(db, turn.campaignId, turn.turnNumber, turn.playerInput, (e) =>
      emit({ type: "staging", text: e.text }),
    );
    if (result.kind === "channel") {
      await db
        .update(turns)
        .set({ status: "channel", completedAt: new Date() })
        .where(eq(turns.id, turnId));
      emit({ type: "channel", intent: result.intent.intent });
      return;
    }
    conte = result.conte;
    ladderSteps = result.ladderSteps;
  } else {
    // Crash-replay: the checkpointed conte IS the turn — same dice (§5.7).
    conte = Conte.parse(turn.conte);
  }

  // --- Phase B (one auto-retry on the SAME conte) -----------------------------
  let sidecar: CommitScene | null = null;
  let narration = turn.narration ?? "";
  if (!checkpoints.phase_b) {
    emit({ type: "staging", text: "writing" });
    const blocks = await assembleForCampaign(db, turn.campaignId);
    if (!blocks) throw new Error("campaign has no premise contract — cannot assemble blocks");
    const contract = TURN_CONTRACTS[conte.tier as TurnTier] ?? TURN_CONTRACTS.genga;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        emit({ type: "reset" });
        emit({ type: "staging", text: "the pen slipped — starting the scene again" });
      }
      try {
        const result = await runKeyAnimator(db, {
          campaignId: turn.campaignId,
          turnNumber: turn.turnNumber,
          conte,
          playerInput: turn.playerInput,
          system: blocks.system,
          selection,
          effort: contract.effort,
          maxTokens: contract.outputBudgetTokens,
          kaResearchCalls: contract.kaResearchCalls,
          ladderSteps,
          profileIds: (campaign.premiseContract as { anchors_used?: string[] })?.anchors_used ?? [],
          emit: (e) =>
            emit(
              e.type === "prose"
                ? { type: "prose", text: e.text }
                : { type: "staging", text: e.text },
            ),
        });
        if (result.refused) throw new Error("narration refused — the scene did not render");
        if (!result.prose.trim()) throw new Error("empty narration");
        narration = result.prose;
        sidecar = result.sidecar;
        await db
          .update(turns)
          .set({
            narration,
            sidecar,
            status: "phase_b_complete",
            checkpoints: sql`${turns.checkpoints} || ${JSON.stringify({
              phase_b: true,
              trailer_fallback: result.trailerFallback,
            })}::jsonb`,
          })
          .where(eq(turns.id, turnId));
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        console.error(`[runtime] Phase B attempt ${attempt + 1} failed`, { turnId, err });
      }
    }
    if (lastError) {
      const message =
        "The scene failed to render twice. Your action is saved — retry when ready; the dice stay as they fell.";
      await db
        .update(turns)
        .set({
          status: "failed",
          checkpoints: sql`${turns.checkpoints} || ${JSON.stringify({ error: String(lastError) })}::jsonb`,
        })
        .where(eq(turns.id, turnId));
      emit({ type: "error", message, retryable: true });
      return;
    }
  } else {
    sidecar = (turn.sidecar as CommitScene | null) ?? null;
    // Resume after a crash between the Phase-B checkpoint and G1: the prose
    // is durable but the reconnecting client's buffer is empty (post-restart)
    // — replay it so the scene actually reaches the player (§5.7), not just
    // a bare 'done'.
    if (narration) emit({ type: "prose", text: narration });
  }

  // --- G1-minimal (§5.8): verbatim episodic + completion markers --------------
  if (!checkpoints.g1) {
    // Idempotent: the partial unique index (campaign, turn) WHERE not
    // tombstoned makes the crash-replay double-write a no-op.
    await db
      .insert(episodicRecords)
      .values({
        campaignId: turn.campaignId,
        turnNumber: turn.turnNumber,
        playerInput: turn.playerInput,
        narration,
        turnId: turn.turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      })
      .onConflictDoNothing();
    await db
      .update(turns)
      .set({
        status: "complete",
        completedAt: new Date(),
        checkpoints: sql`${turns.checkpoints} || '{"g1": true}'::jsonb`,
      })
      .where(eq(turns.id, turnId));
  }

  emit({
    type: "done",
    turnNumber: turn.turnNumber,
    decisionPoint: sidecar?.decision_point ?? false,
    suggestedMoves: sidecar?.suggested_moves ?? [],
    degraded: conte.degraded,
  });
}
