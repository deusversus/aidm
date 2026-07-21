/**
 * Shared soak harness machinery (M1 soak → extracted for the M2 drift soak).
 * Everything here is the battle-tested turn-driving core from scripts/soak.ts
 * runs #1-#3, moved verbatim: the live-turn discipline (a turn is only "past"
 * when its ROW is terminal), the retry-route ordering (executeTurn kicked
 * BEFORE awaitTerminal re-attaches), per-turn metering against the §10.8
 * assertions, and spend attribution with per-tier projections.
 */

import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { type UsageStats, estimateCostUsd } from "@/lib/llm/pricing";
import { TIER_MENUS } from "@/lib/llm/tiers";
import { type TurnEvent, attachToTurn, executeTurn, submitTurn } from "@/lib/turn/runtime";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import { and, eq, gte } from "drizzle-orm";
import {
  BUDGET_ASSUMPTIONS,
  assertTurnCost,
  turnCostModel,
} from "../evals/suites/budget-assertions";

export const TURN_TIMEOUT_MS = 180_000;
export const CACHE_READ_FLOOR = 0.5;

export function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

/** Standing directive: no automated run ever calls Fable. */
export function guardNoFable(selection: Record<string, string>): void {
  for (const [tier, model] of Object.entries(selection)) {
    if (model.toLowerCase().includes("fable")) {
      console.error(
        `[soak] FATAL: tier '${tier}' resolves to '${model}' — a Fable model. Automated runs never call Fable (standing directive). Aborting.`,
      );
      process.exit(1);
    }
  }
}

/** The Bebop Opening State Package both soaks seed from (validated by caller). */
export const BEBOP_OSP = {
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
// One turn through the real loop.
// ---------------------------------------------------------------------------

export type Terminal = "done" | "channel" | "error" | "timeout";

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

export interface TurnRun {
  turnId: string;
  turnNumber: number;
  terminal: Terminal;
  ttftMs: number | null;
  totalMs: number;
  prose: string;
  retried: boolean;
}

/** A turn is only "past" when its ROW is terminal (soak crash #1). A poll
 *  query that dies on a dropped connection (Railway proxy — drift-soak
 *  crashes #2/#3 both died HERE) retries on the next tick instead of
 *  aborting a user-gated run. */
export async function waitForRowTerminal(
  db: Db,
  turnId: string,
  capMs: number,
): Promise<"complete" | "channel" | "failed" | "stuck"> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    try {
      const [row] = await db
        .select({ status: schema.turns.status })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId));
      const s = row?.status ?? "missing";
      if (s === "complete" || s === "channel" || s === "failed") return s;
    } catch (err) {
      console.warn(
        "[soak] poll query failed (transient connection drop) — retrying:",
        err instanceof Error ? err.message : err,
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return "stuck";
}

export async function runOneTurn(db: Db, campaignId: string, input: string): Promise<TurnRun> {
  const submitTime = Date.now();
  const { turnId, turnNumber } = await submitTurn(db, campaignId, input);
  let res = await awaitTerminal(turnId, submitTime);
  let retried = false;

  if (res.terminal === "timeout") {
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
  }

  if (res.terminal === "error") {
    // Retry-route (§5.7). ORDER MATTERS (C10 audit): executeTurn's synchronous
    // prefix resets the event buffer BEFORE the first await — kick it before
    // awaitTerminal attaches, or the attach replays the stale terminal.
    retried = true;
    await db.update(schema.turns).set({ status: "queued" }).where(eq(schema.turns.id, turnId));
    const retryTime = Date.now();
    void executeTurn(db, turnId).catch((err) =>
      console.error("[soak] retry execution crashed", { turnId, err }),
    );
    res = await awaitTerminal(turnId, retryTime);
    if (res.terminal === "timeout") {
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
// Per-turn metering (§10.8).
// ---------------------------------------------------------------------------

export type CallRow = typeof schema.modelCalls.$inferSelect;

export interface TurnRecord {
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

export function usageOf(row: CallRow): UsageStats {
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

export function asTier(t: string): TurnTier {
  return t === "douga" || t === "sakuga" ? t : "genga";
}

function primaryNarration(rows: CallRow[]): CallRow | null {
  const narr = rows.filter((r) => r.tier === "narration");
  if (narr.length === 0) return null;
  return narr.reduce((best, r) => (readable(r) > readable(best) ? r : best));
}

export async function meterTurn(
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

  if (fallbackUsed) {
    failures.push(
      `turn ${run.turnNumber}: fallbackUsed=true on a DEV tier (Fable path must be dead)`,
    );
  }
  if (run.retried) flags.push("retried once after a retryable error");
  if (run.terminal === "timeout")
    failures.push(`turn ${run.turnNumber}: hit the ${TURN_TIMEOUT_MS}ms timeout`);

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
    const absolute = assertTurnCost(turnTier, narrationUsd);
    if (absolute) failures.push(`turn ${run.turnNumber}: ${absolute}`);

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
// Drift verdict classification (§4.5 M2R3 — the third class).
// ---------------------------------------------------------------------------

/** One blind reading of an axis at a sample, as the soak snapshots it. */
export interface DriftPoint {
  atTurn: number;
  delta: number;
  confidence: number;
  consecutiveDrift: number;
}

/** The engine's triple gate (imported values passed in, never re-hardcoded). */
export interface DriftGate {
  threshold: number;
  confidence: number;
  consecutive: number;
}

/**
 * How an axis's drift sequence resolves at run end (§4.5 gate parity):
 *  - clean         never drifted
 *  - corrected     drifted out, then pulled back in band (the machinery WORKING)
 *  - unresolved    final read drifting but below the consecutive trigger (never due)
 *  - player_driven gate tripped, the attribution charged the PLAYER, the retake
 *                  closed — ESCALATED to steering honesty, NOT a fail (M2R3)
 *  - uncorrected   gate tripped and STILL engaged at run end — the FAIL
 *
 * The `player_driven` class is what the M2 drift soak lacked: continuity ended
 * the run engaged (delta 5.2, 13 consecutive) but the PLAYER drove it, and the
 * harness had no box for "the player did it" — so it read FAIL. With the drift
 * band's gate-trip attribution, such an axis is escalated, not failed.
 */
export type AxisVerdictClass =
  | "clean"
  | "corrected"
  | "unresolved"
  | "player_driven"
  | "uncorrected";

export function classifyAxisVerdict(
  seq: DriftPoint[],
  gate: DriftGate,
  playerDriven: boolean,
): AxisVerdictClass {
  const drifting = (x: DriftPoint) => x.delta >= gate.threshold && x.confidence >= gate.confidence;
  const engaged = (x: DriftPoint) => drifting(x) && x.consecutiveDrift >= gate.consecutive;
  const ordered = seq.slice().sort((a, b) => a.atTurn - b.atTurn);
  const last = ordered[ordered.length - 1];
  if (!last || !ordered.some(drifting)) return "clean";
  if (engaged(last)) return playerDriven ? "player_driven" : "uncorrected";
  if (drifting(last)) return "unresolved";
  return "corrected";
}

// ---------------------------------------------------------------------------
// Spend attribution.
// ---------------------------------------------------------------------------

export interface SpendAttribution {
  totalUsd: number;
  attributedUsd: number;
  overheadUsd: number;
  turnsPerSession: number;
  avgNonNarrationUsd: number;
  avgCacheReadFrac: number | null;
  projections: { model: string; perTurnUsd: number; perSessionUsd: number }[];
}

export async function attributeSpend(
  db: Db,
  campaignId: string,
  records: TurnRecord[],
  sessions: number,
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

  const story = records.filter((r) => r.narrationUsage !== null && r.status === "complete");
  const turnsPerSession = Math.max(1, Math.round(story.length / sessions));

  const avgNonNarrationUsd =
    story.length > 0
      ? story.reduce((sum, r) => sum + (r.turnUsd - r.narrationUsd), 0) / story.length
      : 0;

  const warmFracs = records.map((r) => r.cacheReadFrac).filter((f): f is number => f !== null);
  const avgCacheReadFrac =
    warmFracs.length > 0 ? warmFracs.reduce((a, b) => a + b, 0) / warmFracs.length : null;

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
