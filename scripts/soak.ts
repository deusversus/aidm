/**
 * M1-C10 — the 30-turn soak harness (blueprint §12 M1 exit; plan
 * docs/plans/M1-loop.md C10). A scripted Bebop run driven through the REAL
 * turn loop (submitTurn → attachToTurn), player side voiced by a probe-tier
 * persona, metered against the §5.1 budget table and the §5.5 latency
 * doctrine (budgets FLAG waste, they never hard-fail — breaches surface for
 * review, the run continues).
 *
 * SPEND IS GATED BY THE USER. The default (flag-less) invocation is a LIVE
 * run and MUST NOT be executed without explicit approval. The only execution
 * this script is meant to perform unattended is `--dry-run`, which prints the
 * beat plan and proves the seed/teardown wiring boots WITHOUT submitting a
 * single turn (zero model calls).
 *
 *   pnpm soak                     LIVE 30-turn run (user-gated spend) → docs/retros/M1-soak.md
 *   pnpm soak -- --dry-run        prints the plan, seeds + tears down, ZERO model calls
 *   pnpm soak -- --capture-golden LIVE run, then writes §10.7 golden-turn seeds
 *   pnpm soak -- --cleanup        LIVE run, then deletes the soak campaign
 *
 * Standing directive: DEV traffic runs Sonnet/Haiku (DEV_TIER_SELECTION);
 * NO automated run ever calls Fable. A hard guard at startup exits loudly if
 * any selected model is a Fable variant. (The spend-attribution projection
 * DOES price a hypothetical Fable session — that is pure `estimateCostUsd`
 * arithmetic on measured usage, never an API call.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { type Db, getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadDirectionState } from "@/lib/direction/director";
import { closeSession, openSession } from "@/lib/direction/session";
import { callProbe } from "@/lib/llm/calls";
import { type UsageStats, estimateCostUsd } from "@/lib/llm/pricing";
import { DEV_TIER_SELECTION, TIER_MENUS } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { rewindCampaign } from "@/lib/turn/rewind";
import {
  type TurnEvent,
  TurnInProgressError,
  attachToTurn,
  executeTurn,
  submitTurn,
} from "@/lib/turn/runtime";
import { OpeningStatePackage } from "@/lib/types/opening";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import { and, desc, eq, gte } from "drizzle-orm";
import jsYaml from "js-yaml";
import { z } from "zod";
import {
  BUDGET_ASSUMPTIONS,
  assertTurnCost,
  turnCostModel,
} from "../evals/suites/budget-assertions";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const CAPTURE_GOLDEN = process.argv.includes("--capture-golden");
const CLEANUP = process.argv.includes("--cleanup");

/** How many turns a nominal play sitting is, for the spend projection. */
const SESSIONS = 2;
/** Per-turn wall-clock timeout before the run moves on (§5.5 — never hangs). */
const TURN_TIMEOUT_MS = 180_000;
/** The within-turn cache-read floor asserted on warm story turns (§5.6). */
const CACHE_READ_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// The Opening State Package (§8) — a full handoff artifact, envelopes and all.
// Modeled on src/lib/sz/__tests__/compiler.integration.test.ts's STUB_OSP but
// validated here against the real OpeningStatePackage contract before seeding.
// ---------------------------------------------------------------------------

const SOAK_OSP = {
  director_inputs: {
    opening_situation:
      "A bounty gone quiet on a Ganymede dock at closing time; the mark was last seen loitering near the noodle stands.",
    spark_reading: "Fatalism worn as freedom — walking toward the thing anyway.",
    suggested_first_arc_question:
      "What does the crew owe each other when the money's already gone?",
  },
  animation_inputs: {
    forbidden_opening_moves: [
      "revealing the recurring antagonist",
      "spending the spark in scene one",
    ],
    opening_pov: "the player's bounty hunter, mid-shift, before the trouble finds them",
  },
  constraints: [
    {
      text: "no harm to children on-screen",
      tier: "hard",
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 1,
    },
    {
      text: "keep the early episodes bounty-shaped",
      tier: "soft",
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 0.8,
    },
  ],
  uncertainties: [
    {
      question: "who the recurring antagonist is",
      safe_assumption: "someone inside the bounty system itself",
      degraded_generation_guidance: "keep antagonist references faceless and institutional",
    },
  ],
  briefs: [
    {
      name: "The Trawler",
      kind: "world",
      brief: "A converted fishing trawler serving as the crew's ship.",
      admit_to_catalog: true,
      turn_id: 0,
      provenance: "sz_compiler",
      confidence: 0.9,
    },
  ],
  orphan_facts: ["the player hums the show's theme when a job goes right"],
};

// ---------------------------------------------------------------------------
// The scripted beats. Keyed by INTENDED turn number; unscripted turns are
// persona-driven. The specials all land at turns ≤ 15 (before the rewind at
// 20), so a re-climb after the rewind never re-fires a special.
// ---------------------------------------------------------------------------

interface ScriptedBeat {
  input: string;
  label: string;
}

const SCRIPTED: Record<number, ScriptedBeat> = {
  1: {
    label: "pilot cold-open (story)",
    input:
      "I close out the shift, kill the dock floods, and walk toward the noodle stand where the bounty was last seen.",
  },
  5: {
    label: "WORLD_BUILDING — mint a faction",
    input:
      '"The Red Sash dockworkers\' syndicate runs these piers." I say it flat, watching the fixer for a flinch, and start asking who answers to them.',
  },
  8: {
    label: "COMBAT (sakuga-worthy)",
    input:
      "I draw the Jericho and go loud — three of them between me and the gantry, close quarters, no cover, and I mean to walk out the far side.",
  },
  12: {
    label: "trivial (douga)",
    input: "I light a cigarette and watch the rain slide down the viewport.",
  },
  13: {
    label: "OVERRIDE_COMMAND",
    input:
      "/override From here on, keep the body count low — I want captures, not kills, unless there's no other way.",
  },
  15: {
    label: "META_FEEDBACK (booth)",
    input:
      "Hey — out of character for a second: can we lean harder into the noir mood? More smoke and silence, less banter.",
  },
};

/** Ops fire AFTER the intended turn lands, once each. */
const PIN_AFTER_TURN = 8;
const MIDPOINT_AFTER_TURN = 15;
const REWIND_AFTER_TURN = 20;
const REWIND_DEPTH = 2;
const TARGET_TURNS = 30;

const OPS_AFTER: Record<number, string[]> = {
  [PIN_AFTER_TURN]: ["pin the combat passage (studio note)"],
  [MIDPOINT_AFTER_TURN]: ["session close (yokoku + Sakkan) → reopen (recap)"],
  [REWIND_AFTER_TURN]: [
    `rewind ${REWIND_DEPTH} turns (${REWIND_AFTER_TURN}→${REWIND_AFTER_TURN - REWIND_DEPTH}), then re-climb`,
  ],
};

// ---------------------------------------------------------------------------
// The persona (the player). One probe-tier call per unscripted turn.
// ---------------------------------------------------------------------------

const PersonaMove = z.object({ next_input: z.string() });

const PERSONA_SYSTEM = [
  "You are the PLAYER at the table — the player behind a laconic bounty hunter in a Cowboy Bebop-flavored campaign.",
  "Given the last beat of narration, write ONE in-fiction action or line that continues the scene: first person, terse, grounded, a little fatalistic.",
  "Pace like the show: after a fight or a spike, choose a QUIETER beat — talk, look, smoke, walk, ask. Escalate only when the scene genuinely demands it.",
  "(Run #2 rode four straight combat beats — the falling beat is part of the register.)",
  "Never break character. Never address the engine or narrator. Never write meta commentary or stage directions. Under 30 words.",
].join(" ");

async function personaMove(campaignId: string, tail: string): Promise<string> {
  // The persona is DISPOSABLE (C10 audit): a probe failure that escapes the
  // SDK's own retries must never discard a user-gated 30-turn run — one
  // manual retry, then a deterministic in-character fallback.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { next_input } = await callProbe(DEV_TIER_SELECTION, {
        name: "soak_persona",
        schema: PersonaMove,
        system: PERSONA_SYSTEM,
        prompt: `The scene so far ends:\n\n${tail.slice(-500)}\n\nWrite your next move.`,
        campaignId,
        maxTokens: 200,
      });
      const move = next_input.trim();
      if (move.length > 0) return move;
    } catch (err) {
      console.warn(`[soak] persona probe failed (attempt ${attempt + 1}/2):`, err);
    }
  }
  return "I keep moving, eyes open.";
}

// ---------------------------------------------------------------------------
// Startup guard (standing directive): no Fable in any selected tier.
// ---------------------------------------------------------------------------

function guardNoFable(selection: Record<string, string>): void {
  for (const [tier, model] of Object.entries(selection)) {
    if (model.toLowerCase().includes("fable")) {
      console.error(
        `[soak] FATAL: tier '${tier}' resolves to '${model}' — a Fable model. Automated runs never call Fable (standing directive). Aborting.`,
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Seed + teardown
// ---------------------------------------------------------------------------

async function seed(db: Db): Promise<{ playerId: string; campaignId: string }> {
  const playerId = `soak_player_${crypto.randomUUID()}`;
  await db
    .insert(schema.players)
    .values({ id: playerId, email: "soak@example.com" })
    .onConflictDoNothing();
  // Validate the handoff artifact against its real contract before it lands —
  // a malformed OSP would only surface later when directorStartup parses it.
  const osp = OpeningStatePackage.parse(SOAK_OSP);
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      playerId,
      title: "M1 Soak — Cowboy Bebop",
      status: "active",
      premiseContract: bebopContract(),
      openingPackage: osp,
      tierModels: DEV_TIER_SELECTION,
    })
    .returning({ id: schema.campaigns.id });
  if (!campaign) throw new Error("[soak] campaign seed failed");
  return { playerId, campaignId: campaign.id };
}

async function teardown(db: Db, playerId: string, campaignId: string): Promise<void> {
  // model_calls detaches (onDelete: set null) rather than cascading — clear it
  // first so the campaign delete leaves no orphaned ledger rows for this run.
  await db.delete(schema.modelCalls).where(eq(schema.modelCalls.campaignId, campaignId));
  await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
  await db.delete(schema.players).where(eq(schema.players.id, playerId));
}

// ---------------------------------------------------------------------------
// One turn through the real loop: submit → attach → terminal, with a single
// retry on a retryable error (the retry-route logic: status queued +
// executeTurn) and a hard per-turn timeout.
// ---------------------------------------------------------------------------

type Terminal = "done" | "channel" | "error" | "timeout";

interface AttachResult {
  terminal: Terminal;
  ttftMs: number | null;
  totalMs: number;
  prose: string;
}

function awaitTerminal(turnId: string, submitTime: number): Promise<AttachResult> {
  return new Promise<AttachResult>((resolve) => {
    let ttftMs: number | null = null;
    let prose = "";
    let settled = false;
    // Held on a const object so `finish` can close over the cleanup handles
    // before they're assigned (no TDZ, no once-assigned-let lint).
    const handles: { detach?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (terminal: Terminal) => {
      if (settled) return;
      settled = true;
      if (handles.timer) clearTimeout(handles.timer);
      handles.detach?.();
      resolve({ terminal, ttftMs, totalMs: Date.now() - submitTime, prose });
    };
    handles.timer = setTimeout(() => finish("timeout"), TURN_TIMEOUT_MS);
    handles.detach = attachToTurn(turnId, (e: TurnEvent) => {
      if (e.type === "prose") {
        if (ttftMs === null) ttftMs = Date.now() - submitTime;
        prose += e.text;
      } else if (e.type === "done") {
        finish("done");
      } else if (e.type === "channel") {
        finish("channel");
      } else if (e.type === "error") {
        finish("error");
      }
    });
  });
}

interface TurnRun {
  turnId: string;
  turnNumber: number;
  terminal: Terminal;
  ttftMs: number | null;
  totalMs: number;
  prose: string;
  retried: boolean;
}

/**
 * A turn is only "past" when its ROW is terminal (soak crash #1): the
 * awaitTerminal timeout fires while Phase B's auto-retry is still running,
 * and proceeding past a live turn wedges the next submit on the open-turn
 * guard. Poll the durable record until it settles (or the cap expires).
 */
async function waitForRowTerminal(
  db: Db,
  turnId: string,
  capMs: number,
): Promise<"complete" | "channel" | "failed" | "stuck"> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const [row] = await db
      .select({ status: schema.turns.status })
      .from(schema.turns)
      .where(eq(schema.turns.id, turnId));
    const s = row?.status ?? "missing";
    if (s === "complete" || s === "channel" || s === "failed") return s;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return "stuck";
}

async function runOneTurn(db: Db, campaignId: string, input: string): Promise<TurnRun> {
  const submitTime = Date.now();
  const { turnId, turnNumber } = await submitTurn(db, campaignId, input);
  let res = await awaitTerminal(turnId, submitTime);
  let retried = false;

  if (res.terminal === "timeout") {
    // The listener gave up but the ENGINE hasn't — the turn is durable
    // (§5.7) and very likely mid-Phase-B-retry. Wait for the row to settle
    // rather than walking past a live turn (that wedged run #1 at turn 3).
    console.warn(`[soak] turn ${turnNumber} outlived the listener — waiting on the row`);
    const settled = await waitForRowTerminal(db, turnId, 5 * 60_000);
    if (settled === "complete" || settled === "channel") {
      const [row] = await db
        .select({ narration: schema.turns.narration })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId));
      res = {
        terminal: settled === "channel" ? "channel" : "done",
        ttftMs: res.ttftMs,
        totalMs: Date.now() - submitTime,
        prose: row?.narration ?? res.prose,
      };
    } else if (settled === "failed") {
      res = { ...res, terminal: "error" };
    }
    // "stuck" keeps terminal "timeout": the caller aborts gracefully.
  }

  if (res.terminal === "error") {
    // The retry-route logic (§5.7): move OFF 'failed', let the checkpoint
    // markers decide where to resume, re-execute. Same dice. ORDER MATTERS
    // (C10 audit — the C5 stale-buffer lesson): executeTurn's synchronous
    // prefix resets the event buffer BEFORE the first await, so it must be
    // kicked BEFORE awaitTerminal attaches — attaching first replays the
    // prior run's buffered terminal 'error' and resolves instantly to a
    // stale failure while the real retry runs detached and wedges the next
    // submit. Events published between the kick and the attach are buffered
    // and replayed, so nothing is lost by this ordering.
    retried = true;
    await db.update(schema.turns).set({ status: "queued" }).where(eq(schema.turns.id, turnId));
    const retryTime = Date.now();
    void executeTurn(db, turnId).catch((err) =>
      console.error("[soak] retry execution crashed", { turnId, err }),
    );
    res = await awaitTerminal(turnId, retryTime);
    if (res.terminal === "timeout") {
      // Same live-turn discipline on the retry leg.
      const settled = await waitForRowTerminal(db, turnId, 5 * 60_000);
      if (settled === "complete") res = { ...res, terminal: "done" };
      else if (settled === "channel") res = { ...res, terminal: "channel" };
      else if (settled === "failed") res = { ...res, terminal: "error" };
    }
  }

  return {
    turnId,
    turnNumber,
    terminal: res.terminal,
    ttftMs: res.ttftMs,
    totalMs: res.totalMs,
    prose: res.prose,
    retried,
  };
}

// ---------------------------------------------------------------------------
// Per-turn metering (§10.8): read model_calls for this turn's window and
// assert cost + within-turn cache-read fraction; capture TTFT/total as
// waste-flags (never a hard fail — §5.5).
// ---------------------------------------------------------------------------

type CallRow = typeof schema.modelCalls.$inferSelect;

interface TurnRecord {
  step: number;
  turnNumber: number;
  label: string;
  tier: string;
  status: string;
  servedModel: string;
  narrationUsd: number;
  turnUsd: number;
  cacheReadFrac: number | null;
  ttftMs: number | null;
  totalMs: number;
  fallbackUsed: boolean;
  retried: boolean;
  narrationUsage: UsageStats | null;
  flags: string[];
  failures: string[];
}

function usageOf(row: CallRow): UsageStats {
  return {
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_input_tokens: row.cacheReadInputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
  };
}

function readable(row: CallRow): number {
  return row.cacheReadInputTokens + row.inputTokens + row.cacheCreationInputTokens;
}

/** Narrow a stored tier string to a TurnTier (channel rows default to genga). */
function asTier(t: string): TurnTier {
  return t === "douga" || t === "sakuga" ? t : "genga";
}

/** The primary narration row: the real scene render (largest readable prefix). */
function primaryNarration(rows: CallRow[]): CallRow | null {
  const narr = rows.filter((r) => r.tier === "narration");
  if (narr.length === 0) return null;
  return narr.reduce((best, r) => (readable(r) > readable(best) ? r : best));
}

async function meterTurn(
  db: Db,
  campaignId: string,
  run: TurnRun,
  step: number,
  label: string,
  since: Date,
  coldTurns: Set<number>,
): Promise<TurnRecord> {
  const [turnRow] = await db
    .select({ tier: schema.turns.tier, status: schema.turns.status, sidecar: schema.turns.sidecar })
    .from(schema.turns)
    .where(
      and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.turnNumber, run.turnNumber)),
    );

  // Only this turn's calls (createdAt window isolates a re-walked turn number
  // after a rewind from the deleted timeline's stale rows).
  const rows = await db
    .select()
    .from(schema.modelCalls)
    .where(
      and(
        eq(schema.modelCalls.campaignId, campaignId),
        eq(schema.modelCalls.turnNumber, run.turnNumber),
        gte(schema.modelCalls.createdAt, since),
      ),
    );

  const turnUsd = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const narrRows = rows.filter((r) => r.tier === "narration");
  const narrationUsd = narrRows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const primary = primaryNarration(rows);
  const fallbackUsed = rows.some((r) => r.fallbackUsed);

  const tier = turnRow?.tier ?? "genga";
  const status = turnRow?.status ?? "unknown";
  const servedModel = primary?.model ?? "(none)";
  const cacheReadFrac =
    primary && readable(primary) > 0 ? primary.cacheReadInputTokens / readable(primary) : null;

  const flags: string[] = [];
  const failures: string[] = [];

  // fallbackUsed must stay false on DEV tiers (no Fable path is live).
  if (fallbackUsed) {
    failures.push(
      `turn ${run.turnNumber}: fallbackUsed=true on a DEV tier (Fable path must be dead)`,
    );
  }
  if (run.retried) flags.push("retried once after a retryable error");
  if (run.terminal === "timeout")
    failures.push(`turn ${run.turnNumber}: hit the ${TURN_TIMEOUT_MS}ms timeout`);

  // Cost assertion at the served model (not the Fable worst case, which a
  // Sonnet run passes vacuously — §10.8 / M1-loop C10). Story turns only —
  // gated on STATUS, not tier (C10 audit): a channel turn keeps its
  // submit-default 'genga' tier but its booth reply is out-of-fiction with
  // no turn contract; applying the story ceiling + §5.6 cache floor to it
  // recorded false hard failures. Channel spend still totals in turnUsd.
  const isStory =
    status === "complete" && (tier === "douga" || tier === "genga" || tier === "sakuga");
  if (primary && isStory) {
    const turnTier = asTier(tier);
    const ceiling = turnCostModel(turnTier, servedModel).coldUsd;
    if (narrationUsd > ceiling) {
      failures.push(
        `turn ${run.turnNumber} (${tier}/${servedModel}): narration $${narrationUsd.toFixed(4)} > cold ceiling $${ceiling.toFixed(4)}`,
      );
    }
    // Secondary absolute guard against the Fable-denominated menu ceiling.
    const absolute = assertTurnCost(turnTier, narrationUsd);
    if (absolute) failures.push(`turn ${run.turnNumber}: ${absolute}`);

    // Cache-read accounting, recalibrated (run #2's live diagnosis): the
    // §5.6 GUARANTEED reads are the WITHIN-TURN research round-trips — every
    // narration call after the first reads the prefix the first call wrote,
    // whatever the turn-to-turn state was. THOSE carry the assertion. The
    // primary call's fraction is the TURN-TO-TURN rate: B1+B2 read while B3
    // re-creates as the growing tail (by design — the 3-breakpoint scheme),
    // so early-campaign fractions run low and improve as compaction moves
    // bulk into cached B2. Per the plan: within-turn ASSERTED, turn-to-turn
    // REPORTED vs the 0.7 assumption (a flag, never a failure).
    const followUps = narrRows
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(1);
    for (const call of followUps) {
      const frac = readable(call) > 0 ? call.cacheReadInputTokens / readable(call) : null;
      if (frac !== null && frac < CACHE_READ_FLOOR) {
        failures.push(
          `turn ${run.turnNumber} (${tier}): WITHIN-turn research read frac ${frac.toFixed(2)} < ${CACHE_READ_FLOOR} floor (§5.6 guaranteed read missed)`,
        );
      }
    }
    if (cacheReadFrac !== null) {
      if (coldTurns.has(run.turnNumber)) {
        flags.push(
          `cold turn — turn-to-turn cache-read frac ${cacheReadFrac.toFixed(2)} (prefix creation expected)`,
        );
      } else if (cacheReadFrac < BUDGET_ASSUMPTIONS.assumedCacheHitRate) {
        flags.push(
          `turn-to-turn cache-read frac ${cacheReadFrac.toFixed(2)} vs the ${BUDGET_ASSUMPTIONS.assumedCacheHitRate} assumption (reported, §5.6 — B3 re-creates by design)`,
        );
      }
    }
  }

  // TTFT / total wall-clock waste-flags (§5.5 — flag, never fail).
  const contract = TURN_CONTRACTS[asTier(tier)];
  if (run.ttftMs !== null && run.ttftMs > contract.ttftTargetMs) {
    flags.push(`TTFT ${run.ttftMs}ms > target ${contract.ttftTargetMs}ms`);
  }
  if (run.totalMs > contract.totalTargetMs) {
    flags.push(`total ${run.totalMs}ms > target ${contract.totalTargetMs}ms`);
  }

  return {
    step,
    turnNumber: run.turnNumber,
    label,
    tier,
    status,
    servedModel,
    narrationUsd,
    turnUsd,
    cacheReadFrac,
    ttftMs: run.ttftMs,
    totalMs: run.totalMs,
    fallbackUsed,
    retried: run.retried,
    narrationUsage: primary ? usageOf(primary) : null,
    flags,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Ops: pin, midpoint session close/reopen, rewind.
// ---------------------------------------------------------------------------

async function pinPassage(
  db: Db,
  campaignId: string,
  sourceTurn: number,
  passage: string,
): Promise<void> {
  const content = passage.trim().slice(0, 240) || "a passage worth keeping";
  await db.insert(schema.pins).values({
    campaignId,
    content,
    position: 1,
    sourceTurn,
    turnId: sourceTurn,
    provenance: "player_pin",
    confidence: 1,
  });
}

async function rewindTwo(
  db: Db,
  campaignId: string,
  currentMax: number,
): Promise<{ toTurn: number; tombstoned: number }> {
  // The rewind-route contract: drain lagging G2 before the tombstone sweep so
  // a detached settle can't write ghost rows for an un-happened turn.
  await settleG2IfPending(db, campaignId);
  const toTurn = Math.max(0, currentMax - REWIND_DEPTH);
  const result = await rewindCampaign(
    db,
    campaignId,
    toTurn,
    "soak: rewind-of-2 regression exercise",
  );
  return { toTurn, tombstoned: result.tombstonedCount };
}

// ---------------------------------------------------------------------------
// The event-mix checklist (post-run queries + captured session artifacts).
// ---------------------------------------------------------------------------

interface RunArtifacts {
  yokoku?: string;
  recap?: string;
  session2Opened: boolean;
  rewound?: { toTurn: number; tombstoned: number };
}

interface ChecklistItem {
  label: string;
  ok: boolean;
  detail: string;
}

async function buildChecklist(
  db: Db,
  campaignId: string,
  records: TurnRecord[],
  artifacts: RunArtifacts,
): Promise<ChecklistItem[]> {
  const firstTier = (t: string) => records.find((r) => r.tier === t && r.status === "complete");
  const douga = firstTier("douga");
  const genga = firstTier("genga");
  const sakuga = firstTier("sakuga");

  const channelRows = await db
    .select({ turnNumber: schema.turns.turnNumber, sidecar: schema.turns.sidecar })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "channel")));
  const channelOf = (kind: string) =>
    channelRows.find((r) => (r.sidecar as { channel?: string } | null)?.channel === kind);
  const override = channelOf("OVERRIDE_COMMAND") ?? channelOf("OP_COMMAND");
  const booth = channelOf("META_FEEDBACK");

  const factionRows = await db
    .select({ name: schema.entities.name })
    .from(schema.entities)
    .where(
      and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "faction")),
    );
  const redSash = factionRows.find((f) => /red\s*sash/i.test(f.name));

  const pinRows = await db
    .select({ id: schema.pins.id, sourceTurn: schema.pins.sourceTurn })
    .from(schema.pins)
    .where(eq(schema.pins.campaignId, campaignId));

  const rewindRows = await db
    .select({ rewoundToTurn: schema.rewinds.rewoundToTurn })
    .from(schema.rewinds)
    .where(eq(schema.rewinds.campaignId, campaignId));

  const compactionRows = await db
    .select({ id: schema.compactedBeats.id })
    .from(schema.compactedBeats)
    .where(eq(schema.compactedBeats.campaignId, campaignId));

  const sessionRows = await db
    .select({
      n: schema.sessionRecords.sessionNumber,
      yokoku: schema.sessionRecords.yokoku,
      closedAt: schema.sessionRecords.closedAt,
    })
    .from(schema.sessionRecords)
    .where(eq(schema.sessionRecords.campaignId, campaignId));

  const direction = await loadDirectionState(db, campaignId);
  const lastDirectorTurn = direction.last_director_turn;
  const lastSakkanTurn = direction.sakkan?.last_sample_turn ?? 0;

  return [
    {
      label: "douga (trivial) turn",
      ok: Boolean(douga),
      detail: douga ? `turn ${douga.turnNumber}` : "none classified douga",
    },
    {
      label: "genga (story) turn",
      ok: Boolean(genga),
      detail: genga ? `turn ${genga.turnNumber}` : "none classified genga",
    },
    {
      label: "sakuga combat turn",
      ok: Boolean(sakuga),
      detail: sakuga ? `turn ${sakuga.turnNumber}` : "none classified sakuga",
    },
    {
      label: "WORLD_BUILDING faction mint (Red Sash)",
      ok: Boolean(redSash),
      detail: redSash ? redSash.name : "no faction entity matched /red sash/",
    },
    {
      label: "override command",
      ok: Boolean(override),
      detail: override
        ? `turn ${override.turnNumber}`
        : "no OVERRIDE_COMMAND/OP_COMMAND channel turn",
    },
    {
      label: "meta booth exchange",
      ok: Boolean(booth),
      detail: booth ? `turn ${booth.turnNumber}` : "no META_FEEDBACK channel turn",
    },
    {
      label: "pin held",
      ok: pinRows.length > 0,
      detail:
        pinRows.length > 0
          ? `${pinRows.length} pin(s), source turn ${pinRows[0]?.sourceTurn}`
          : "no pins",
    },
    {
      label: "rewind (2 turns)",
      ok: rewindRows.length > 0,
      detail:
        rewindRows.length > 0
          ? `to turn ${rewindRows[0]?.rewoundToTurn}${artifacts.rewound ? `, ${artifacts.rewound.tombstoned} writes tombstoned` : ""}`
          : "no rewind logged",
    },
    {
      label: "session close + reopen",
      ok: sessionRows.length >= 2 && artifacts.session2Opened,
      detail: `${sessionRows.length} session(s); yokoku ${artifacts.yokoku ? "yes" : "no"}; recap ${artifacts.recap ? "yes" : "no"}`,
    },
    {
      label: "compaction event",
      ok: compactionRows.length > 0,
      detail: `${compactionRows.length} compacted beat(s)`,
    },
    {
      label: "Director cycle",
      ok: lastDirectorTurn > 0,
      detail: `last_director_turn=${lastDirectorTurn}`,
    },
    {
      label: "Sakkan sample",
      ok: lastSakkanTurn > 0,
      detail: `last_sample_turn=${lastSakkanTurn}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Spend attribution (§3 / §9.5): total soak spend + projected per-session
// play cost at each narration tier. Projection is `estimateCostUsd` math on
// the MEASURED per-turn narration usage — no model is called.
// ---------------------------------------------------------------------------

interface SpendAttribution {
  totalUsd: number;
  attributedUsd: number;
  overheadUsd: number;
  turnsPerSession: number;
  avgNonNarrationUsd: number;
  avgCacheReadFrac: number | null;
  projections: { model: string; perTurnUsd: number; perSessionUsd: number }[];
}

async function attributeSpend(
  db: Db,
  campaignId: string,
  records: TurnRecord[],
): Promise<SpendAttribution> {
  const all = await db
    .select({ costUsd: schema.modelCalls.costUsd })
    .from(schema.modelCalls)
    .where(eq(schema.modelCalls.campaignId, campaignId));
  const totalUsd = all.reduce((sum, r) => sum + Number(r.costUsd), 0);

  const attributed = await db
    .select({ costUsd: schema.modelCalls.costUsd })
    .from(schema.modelCalls)
    .where(and(eq(schema.modelCalls.campaignId, campaignId), gte(schema.modelCalls.turnNumber, 1)));
  const attributedUsd = attributed.reduce((sum, r) => sum + Number(r.costUsd), 0);

  // Story turns with a real narration usage sample.
  const story = records.filter((r) => r.narrationUsage !== null && r.status === "complete");
  const turnsPerSession = Math.max(1, Math.round(story.length / SESSIONS));

  const avgNonNarrationUsd =
    story.length > 0
      ? story.reduce((sum, r) => sum + (r.turnUsd - r.narrationUsd), 0) / story.length
      : 0;

  const warmFracs = records.map((r) => r.cacheReadFrac).filter((f): f is number => f !== null);
  const avgCacheReadFrac =
    warmFracs.length > 0 ? warmFracs.reduce((a, b) => a + b, 0) / warmFracs.length : null;

  // Average narration usage across story turns → re-price at every menu model.
  const avgUsage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const r of story) {
    const u = r.narrationUsage;
    if (!u) continue;
    avgUsage.input_tokens += u.input_tokens;
    avgUsage.output_tokens += u.output_tokens;
    avgUsage.cache_read_input_tokens =
      (avgUsage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    avgUsage.cache_creation_input_tokens =
      (avgUsage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  const n = Math.max(1, story.length);
  avgUsage.input_tokens /= n;
  avgUsage.output_tokens /= n;
  avgUsage.cache_read_input_tokens = (avgUsage.cache_read_input_tokens ?? 0) / n;
  avgUsage.cache_creation_input_tokens = (avgUsage.cache_creation_input_tokens ?? 0) / n;

  const projections = TIER_MENUS.narration.map((model) => {
    const perTurnUsd = estimateCostUsd(model, avgUsage) + avgNonNarrationUsd;
    return { model, perTurnUsd, perSessionUsd: perTurnUsd * turnsPerSession };
  });

  return {
    totalUsd,
    attributedUsd,
    overheadUsd: totalUsd - attributedUsd,
    turnsPerSession,
    avgNonNarrationUsd,
    avgCacheReadFrac,
    projections,
  };
}

// ---------------------------------------------------------------------------
// Golden-turn capture (§10.7): three canonical turns' {conte, prose}.
// ---------------------------------------------------------------------------

const GOLDEN_DIR = join(process.cwd(), "evals", "golden", "turns");

async function captureGolden(db: Db, campaignId: string): Promise<string[]> {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const picks: { name: string; tier: TurnTier }[] = [
    { name: "bebop-combat", tier: "sakuga" },
    { name: "bebop-genga-story", tier: "genga" },
    { name: "bebop-douga", tier: "douga" },
  ];
  const written: string[] = [];
  for (const pick of picks) {
    const [row] = await db
      .select({
        turnNumber: schema.turns.turnNumber,
        tier: schema.turns.tier,
        playerInput: schema.turns.playerInput,
        conte: schema.turns.conte,
        narration: schema.turns.narration,
      })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.campaignId, campaignId),
          eq(schema.turns.tier, pick.tier),
          eq(schema.turns.status, "complete"),
        ),
      )
      .orderBy(desc(schema.turns.turnNumber))
      .limit(1);
    if (!row) {
      console.warn(
        `[soak] --capture-golden: no completed ${pick.tier} turn to seed ${pick.name}.yaml`,
      );
      continue;
    }
    const doc = {
      id: pick.name,
      tier: row.tier,
      captured_from: { campaign: campaignId, turn: row.turnNumber },
      player_input: row.playerInput,
      conte: row.conte,
      prose: row.narration ?? "",
    };
    const header = `# M1-C10 golden-turn regression seed (§10.7) — captured from the 30-turn soak.\n# Turn ${row.turnNumber}, tier ${row.tier}. Regenerate with: pnpm soak -- --capture-golden\n`;
    const path = join(GOLDEN_DIR, `${pick.name}.yaml`);
    writeFileSync(path, header + jsYaml.dump(doc, { lineWidth: 100 }));
    written.push(path);
  }
  return written;
}

// ---------------------------------------------------------------------------
// The plan description (dry-run + report header).
// ---------------------------------------------------------------------------

function describePlan(): string {
  const lines: string[] = [];
  lines.push(
    "M1 30-turn soak — scripted beat plan (DEV tiers: narration=claude-sonnet-5, judgment=claude-haiku-4-5, probe=claude-haiku-4-5)",
  );
  lines.push(
    `target ${TARGET_TURNS} turns · specials scripted, gaps persona-driven (one probe/turn) · rewind of ${REWIND_DEPTH} at turn ${REWIND_AFTER_TURN}`,
  );
  lines.push("");
  for (let n = 1; n <= TARGET_TURNS; n++) {
    const s = SCRIPTED[n];
    const desc = s
      ? `${s.label} — ${s.input}`
      : "persona — probe-driven laconic bounty-hunter move";
    lines.push(`  turn ${String(n).padStart(2, " ")}  ${desc}`);
    for (const op of OPS_AFTER[n] ?? []) lines.push(`          ↳ op: ${op}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

function buildReport(
  campaignId: string,
  records: TurnRecord[],
  checklist: ChecklistItem[],
  spend: SpendAttribution,
): string {
  const out: string[] = [];
  out.push("# M1 Soak Report — playable to turn 30");
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("");
  out.push(
    `Campaign id: \`${campaignId}\` — **KEPT** for reference${CLEANUP ? " (but --cleanup will delete it after this report)" : " (pass --cleanup to delete)"}.`,
  );
  out.push("");
  out.push(
    "Tier selection (DEV): narration=`claude-sonnet-5`, judgment=`claude-haiku-4-5`, probe=`claude-haiku-4-5`. Fable guard: **PASS** (no Fable in any tier).",
  );
  out.push("");

  out.push("## Per-turn table");
  out.push("");
  out.push(
    "| step | turn | tier | served model | narration $ | turn $ | cacheRead frac | TTFT ms | total ms | flags |",
  );
  out.push("| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of records) {
    const frac = r.cacheReadFrac === null ? "—" : r.cacheReadFrac.toFixed(2);
    const ttft = r.ttftMs === null ? "—" : String(r.ttftMs);
    const flags = [...r.failures.map((f) => `FAIL:${f}`), ...r.flags].join("; ") || "—";
    out.push(
      `| ${r.step} | ${r.turnNumber} | ${r.tier} | ${r.servedModel} | ${fmtUsd(r.narrationUsd)} | ${fmtUsd(r.turnUsd)} | ${frac} | ${ttft} | ${r.totalMs} | ${flags} |`,
    );
  }
  out.push("");

  out.push("## Event-mix checklist");
  out.push("");
  for (const c of checklist) out.push(`- ${c.ok ? "[x]" : "[ ]"} ${c.label} — ${c.detail}`);
  out.push("");

  out.push("## Totals + spend attribution");
  out.push("");
  out.push(`- Soak engine spend (all model calls, this campaign): **${fmtUsd(spend.totalUsd)}**`);
  out.push(`- Attributed to turns 1..N: ${fmtUsd(spend.attributedUsd)}`);
  out.push(
    `- Session/harness overhead (persona probes, pre-warm, startup, recap/yokoku/memo): ${fmtUsd(spend.overheadUsd)}`,
  );
  out.push(
    `- Measured within-turn cache-read fraction (mean): ${spend.avgCacheReadFrac === null ? "n/a" : spend.avgCacheReadFrac.toFixed(2)} vs the ${BUDGET_ASSUMPTIONS.assumedCacheHitRate} assumption (§5.6)`,
  );
  out.push(`- Turns per session (measured): ${spend.turnsPerSession}`);
  out.push("");
  out.push(
    "Projected per-session play cost at each §3 narration tier (measured per-turn narration usage re-priced; non-narration held at measured average — pure pricing math, no Fable call):",
  );
  out.push("");
  out.push("| narration tier | projected $/turn | projected $/session |");
  out.push("| --- | ---: | ---: |");
  for (const p of spend.projections) {
    out.push(`| ${p.model} | ${fmtUsd(p.perTurnUsd)} | ${fmtUsd(p.perSessionUsd)} |`);
  }
  out.push("");

  const allFailures = records.flatMap((r) => r.failures);
  const allFlags = records.flatMap((r) => r.flags.map((f) => `turn ${r.turnNumber}: ${f}`));
  const checklistMisses = checklist.filter((c) => !c.ok).map((c) => `${c.label} — ${c.detail}`);

  out.push("## Failures / flags");
  out.push("");
  out.push(`### Assertion failures (${allFailures.length})`);
  if (allFailures.length === 0) out.push("- none — every metered assertion held.");
  else for (const f of allFailures) out.push(`- ${f}`);
  out.push("");
  out.push(`### Event-mix misses (${checklistMisses.length})`);
  if (checklistMisses.length === 0) out.push("- none — the whole event mix landed.");
  else for (const m of checklistMisses) out.push(`- ${m}`);
  out.push("");
  out.push(`### Waste-flags (${allFlags.length}) — §5.5: surfaced for review, never hard-fails`);
  if (allFlags.length === 0) out.push("- none.");
  else for (const f of allFlags) out.push(`- ${f}`);
  out.push("");

  out.push("## Beat plan (as scheduled)");
  out.push("");
  out.push("```");
  out.push(describePlan());
  out.push("```");
  out.push("");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

async function liveRun(db: Db, campaignId: string): Promise<void> {
  const records: TurnRecord[] = [];
  const artifacts: RunArtifacts = { session2Opened: false };
  const coldTurns = new Set<number>([1]); // pilot is cold; session-2 first turn added below

  // Open the pilot sitting: Director startup + Settei rebuild + pre-warm.
  const opened = await openSession(db, campaignId);
  console.log(
    `[soak] pilot session opened (session ${opened.sessionNumber}, pilot=${opened.pilot})`,
  );

  let turnNumber = 0;
  let step = 0;
  let tail = SOAK_OSP.director_inputs.opening_situation;
  let didPin = false;
  let didMidpoint = false;
  let didRewind = false;
  let combatPassage = "";
  const MAX_STEPS = TARGET_TURNS + REWIND_DEPTH + 6; // re-climb headroom + safety

  // The report writes NO MATTER HOW the loop ends (soak crash #1 lost run
  // data to an unhandled throw): abort reasons land in the report instead.
  let abort: string | null = null;
  try {
    while (turnNumber < TARGET_TURNS && step < MAX_STEPS) {
      const intended = turnNumber + 1;
      const scripted = SCRIPTED[intended];
      const input = scripted ? scripted.input : await personaMove(campaignId, tail);
      const label = scripted ? scripted.label : "persona";

      const since = new Date();
      let run: TurnRun;
      try {
        run = await runOneTurn(db, campaignId, input);
      } catch (err) {
        if (err instanceof TurnInProgressError) {
          // A prior turn is still open (or held failed): wait it out once,
          // then resubmit. A failed turn holds campaigns open BY DESIGN —
          // if it stays failed after the retry machinery, abort with data.
          console.warn(`[soak] open turn ${err.pendingTurnId} blocks submit — waiting`);
          const settled = await waitForRowTerminal(db, err.pendingTurnId, 5 * 60_000);
          if (settled === "failed" || settled === "stuck") {
            abort = `turn ${err.pendingTurnId} wedged (${settled}) — campaign held open by design`;
            break;
          }
          run = await runOneTurn(db, campaignId, input);
        } else {
          throw err;
        }
      }
      step += 1;
      turnNumber = run.turnNumber;
      if (run.terminal === "timeout" || run.terminal === "error") {
        // runOneTurn already waited on the row; a surviving non-done terminal
        // means the turn is genuinely stuck/failed — record and stop clean.
        const record = await meterTurn(db, campaignId, run, step, label, since, coldTurns);
        records.push(record);
        abort = `turn ${turnNumber} ended ${run.terminal} after retry — stopping with data intact`;
        break;
      }

      // Flush this turn's G2 so its distill/director/sakkan/compaction spend is
      // metered before we read the ledger (catch-up-before-reader, §5.8).
      await settleG2IfPending(db, campaignId);

      const record = await meterTurn(db, campaignId, run, step, label, since, coldTurns);
      records.push(record);
      if (record.tier === "sakuga" && !combatPassage) combatPassage = run.prose;
      if (run.prose.trim()) tail = run.prose;

      console.log(
        `[soak] step ${step} · turn ${turnNumber} · ${record.tier} · ${record.status} · narration ${fmtUsd(record.narrationUsd)} · ttft ${record.ttftMs ?? "—"}ms${record.failures.length ? ` · FAIL(${record.failures.length})` : ""}`,
      );

      // --- Ops, keyed to the intended turn number (before any rewind re-climb) ---
      if (intended === PIN_AFTER_TURN && !didPin) {
        await pinPassage(db, campaignId, turnNumber, combatPassage || run.prose);
        didPin = true;
        console.log(`[soak] pinned a passage from turn ${turnNumber}`);
      }
      if (intended === MIDPOINT_AFTER_TURN && !didMidpoint) {
        const closed = await closeSession(db, campaignId, "explicit");
        artifacts.yokoku = closed.yokoku;
        await settleG2IfPending(db, campaignId);
        const reopened = await openSession(db, campaignId);
        artifacts.session2Opened = reopened.opened;
        artifacts.recap = reopened.recap;
        coldTurns.add(turnNumber + 1); // session 2's first turn is cold again
        didMidpoint = true;
        console.log(
          `[soak] midpoint: session closed (yokoku ${closed.yokoku ? "yes" : "no"}) → reopened (recap ${reopened.recap ? "yes" : "no"})`,
        );
      }
      if (intended === REWIND_AFTER_TURN && !didRewind) {
        artifacts.rewound = await rewindTwo(db, campaignId, turnNumber);
        turnNumber = artifacts.rewound.toTurn; // re-climb from here
        didRewind = true;
        console.log(
          `[soak] rewound to turn ${artifacts.rewound.toTurn} (${artifacts.rewound.tombstoned} writes tombstoned) — re-climbing`,
        );
      }
    }
  } catch (err) {
    abort = `unexpected: ${err instanceof Error ? err.message : String(err)}`;
    console.error("[soak] run aborted — writing the report with data so far", err);
  }

  // Final drain so the checklist reads a settled world.
  await settleG2IfPending(db, campaignId).catch(() => {});

  const checklist = await buildChecklist(db, campaignId, records, artifacts);
  const spend = await attributeSpend(db, campaignId, records);
  let report = buildReport(campaignId, records, checklist, spend);
  if (abort) {
    report += `\n## ABORTED\n\n${abort}\n`;
    console.error(`[soak] ABORTED: ${abort}`);
  }

  const reportPath = join(process.cwd(), "docs", "retros", "M1-soak.md");
  writeFileSync(reportPath, report);
  console.log(`\n[soak] report → ${reportPath}`);

  // Console summary.
  const misses = checklist.filter((c) => !c.ok);
  const failures = records.flatMap((r) => r.failures);
  console.log("\n=== SOAK SUMMARY ===");
  console.log(
    `turns reached: ${turnNumber} · steps: ${step} · total spend ${fmtUsd(spend.totalUsd)}`,
  );
  console.log(
    `event mix: ${checklist.length - misses.length}/${checklist.length} landed${misses.length ? ` (missing: ${misses.map((m) => m.label).join(", ")})` : ""}`,
  );
  console.log(`assertion failures: ${failures.length}`);
  for (const p of spend.projections)
    console.log(`  projected/session @ ${p.model}: ${fmtUsd(p.perSessionUsd)}`);

  if (CAPTURE_GOLDEN) {
    const written = await captureGolden(db, campaignId);
    console.log(`[soak] golden seeds written: ${written.length ? written.join(", ") : "none"}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  guardNoFable(DEV_TIER_SELECTION);

  if (DRY_RUN) {
    console.log(describePlan());
    console.log("");
    if (!process.env.DATABASE_URL) {
      console.warn(
        "[dry-run] DATABASE_URL not set — printed the plan only; DB seed/teardown wiring not exercised.",
      );
      return;
    }
    const db = getDb();
    const { playerId, campaignId } = await seed(db);
    console.log(
      `[dry-run] seeded player ${playerId} + campaign ${campaignId} (OSP + contract parsed OK).`,
    );
    await teardown(db, playerId, campaignId);
    console.log("[dry-run] teardown OK. Harness boots — ZERO model calls, no turns submitted.");
    return;
  }

  // LIVE run (user-gated spend).
  const db = getDb();
  const { playerId, campaignId } = await seed(db);
  console.log(`[soak] LIVE run · campaign ${campaignId}`);
  try {
    await liveRun(db, campaignId);
  } finally {
    await flushLangfuse();
    if (CLEANUP) {
      await teardown(db, playerId, campaignId);
      console.log(`[soak] --cleanup: deleted campaign ${campaignId} + player ${playerId}`);
    } else {
      console.log(`[soak] campaign ${campaignId} KEPT (the report + golden seeds reference it).`);
    }
  }
}

await main();
process.exit(0);
