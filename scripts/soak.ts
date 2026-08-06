/**
 * The soak harness (blueprint §12 M1 exit, plan docs/plans/M1-loop.md C10;
 * extended to the §10.3 long run at M3 C5). A scripted Bebop run driven
 * through the REAL turn loop (submitTurn → attachToTurn), player side voiced
 * by a probe-tier persona, metered against the §5.1 budget table and the §5.5
 * latency doctrine (budgets FLAG waste, they never hard-fail — breaches
 * surface for review, the run continues).
 *
 * SPEND IS GATED BY THE USER. The default (flag-less) invocation is a LIVE
 * run and MUST NOT be executed without explicit approval; every invocation
 * prints its PRICE ESTIMATE first. The only execution this script is meant to
 * perform unattended is `--dry-run`, which prints the beat plan and proves the
 * seed/teardown wiring boots WITHOUT submitting a single turn (zero model
 * calls) — at any N.
 *
 *   pnpm soak                     LIVE 30-turn run (user-gated) → docs/retros/soak-30turn.md
 *   pnpm soak -- --turns=100      the §10.3 long run — the M3 gate depth
 *   pnpm soak -- --dry-run        prints the plan, seeds + tears down, ZERO model calls
 *   pnpm soak -- --capture-golden LIVE run, then writes §10.7 golden-turn seeds
 *   pnpm soak -- --cleanup        LIVE run, then deletes the soak campaign
 *   pnpm soak -- --campaign=<id> --turns=50
 *                                 RESUME an existing soak campaign: plays only the
 *                                 STORY turns it is short of the target and appends
 *                                 a "## Resume" section to the run's report.
 *
 * `--turns=N` is a STORY-turn target, not a turn-number count: a channel beat
 * (a booth exchange, an `/override`) consumes a turn number and writes no
 * scene. The N=50 gate run of 2026-08-05 played 50 numbered turns with two
 * channel beats among them and banked 48 completed story turns — one gate short
 * of §10.3's floor, so flywheel-prospective SKIPPED the run it exists to grade.
 *
 * Standing directive: DEV traffic runs Sonnet/Haiku (DEV_TIER_SELECTION);
 * NO automated run ever calls Fable. A hard guard at startup exits loudly if
 * any selected model is a Fable variant. (The spend-attribution projection
 * DOES price a hypothetical Fable session — that is pure `estimateCostUsd`
 * arithmetic on measured usage, never an API call.)
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactionWatermark, epochEventCount } from "@/lib/blocks/compaction";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { type Db, getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadDirectionState } from "@/lib/direction/director";
import { closeSession, openSession } from "@/lib/direction/session";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { rewindCampaign } from "@/lib/turn/rewind";
import { TurnInProgressError } from "@/lib/turn/runtime";
import { OpeningStatePackage } from "@/lib/types/opening";
import type { TurnTier } from "@/lib/types/turn";
import { and, desc, eq, gte } from "drizzle-orm";
import jsYaml from "js-yaml";
import { z } from "zod";
import { BUDGET_ASSUMPTIONS } from "../evals/suites/budget-assertions";
import { MIN_SOAK_TURNS } from "../evals/suites/flywheel-prospective";
import {
  BEBOP_OSP,
  type MeteringCoverage,
  type SessionCoverage,
  type SoakPlan,
  type SpendAttribution,
  type TurnRecord,
  type TurnRun,
  assertSoakCampaign,
  attributeSpend,
  buildSoakPlan,
  countStoryTurns,
  dbNow,
  droppedOps,
  estimateRunPrice,
  fmtUsd,
  guardNoFable,
  maxTurnNumber,
  meterSettledTurn,
  meterTurn,
  meteringCoverage,
  openSittingNumber,
  planWindow,
  resumePlan,
  runOneTurn,
  sessionCoverage,
  waitForRowTerminal,
} from "./soak-lib";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const CAPTURE_GOLDEN = process.argv.includes("--capture-golden");
const CLEANUP = process.argv.includes("--cleanup");

/** `--turns=N` (default 30, the M1 shape) — a STORY-turn target. The M3 gate
 *  runs 100 (§10.3 asks 50–100; the M2 gate ran 24 against that letter — a
 *  recorded discrepancy). */
function parseTurns(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--turns="));
  if (!flag) return 30;
  const n = Number(flag.slice("--turns=".length));
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    console.error(`[soak] FATAL: --turns must be an integer in 1..500 (got '${flag}')`);
    process.exit(1);
  }
  return n;
}

/** `--campaign=<uuid>` resumes an existing soak campaign instead of seeding a
 *  fresh one — the path back from a run that landed short of its story target. */
function parseCampaign(argv: string[]): string | null {
  const flag = argv.find((a) => a.startsWith("--campaign="));
  if (!flag) return null;
  const id = flag.slice("--campaign=".length).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    console.error(`[soak] FATAL: --campaign must be a campaign uuid (got '${id}')`);
    process.exit(1);
  }
  return id;
}

const TARGET_TURNS = parseTurns(process.argv);
const RESUME_CAMPAIGN = parseCampaign(process.argv);

if (RESUME_CAMPAIGN && CLEANUP) {
  // --cleanup deletes the campaign it ran. On a resume that campaign is the
  // gate's own record — the thing the resume exists to complete.
  console.error("[soak] FATAL: --cleanup with --campaign would delete the campaign being resumed");
  process.exit(1);
}

/** How many turns a nominal play sitting is, for the spend projection. A resume
 *  opens exactly one sitting for the turns it adds. */
const SESSIONS = RESUME_CAMPAIGN ? 1 : 2;
// ---------------------------------------------------------------------------
// The Opening State Package (§8) — a full handoff artifact, envelopes and all.
// Modeled on src/lib/sz/__tests__/compiler.integration.test.ts's STUB_OSP but
// validated here against the real OpeningStatePackage contract before seeding.
// ---------------------------------------------------------------------------

const SOAK_OSP = BEBOP_OSP;

// ---------------------------------------------------------------------------
// The scripted beats. Keyed by INTENDED turn number; unscripted turns are
// persona-driven. The specials all land at turns ≤ 15 (before the rewind at
// 20), so a re-climb after the rewind never re-fires a special.
// ---------------------------------------------------------------------------

interface ScriptedBeat {
  input: string;
  label: string;
  /** A CHANNEL beat: routed to the booth / override responder, not the pen. It
   *  consumes a turn number and produces no scene, so it never counts toward
   *  the story-turn target the §10.3 gate reads. */
  channel?: true;
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
    channel: true,
    input:
      "/override From here on, keep the body count low — I want captures, not kills, unless there's no other way.",
  },
  15: {
    label: "META_FEEDBACK (booth)",
    channel: true,
    input:
      "Hey — out of character for a second: can we lean harder into the noir mood? More smoke and silence, less banter.",
  },
};

/** The scheduled channel beats, by turn number — what `planWindow` walks past. */
const CHANNEL_BEATS = new Set(
  Object.entries(SCRIPTED)
    .filter(([, beat]) => beat.channel === true)
    .map(([turn]) => Number(turn)),
);
const isChannelBeat = (turn: number): boolean => CHANNEL_BEATS.has(turn);

/** Ops fire AFTER the intended turn lands, once each. The pin rides the combat
 *  special, so it keeps that special's turn; the midpoint and the rewind are
 *  structural and scale with N (buildSoakPlan). */
const PIN_AFTER_TURN = 8;
const REWIND_DEPTH = 2;
/** The fresh run's window: N story turns plus whatever channel beats the plan
 *  schedules among the turn numbers it walks through to reach them. */
const FRESH_WINDOW = planWindow(0, TARGET_TURNS, isChannelBeat);
const PLAN: SoakPlan = buildSoakPlan(
  TARGET_TURNS,
  PIN_AFTER_TURN,
  REWIND_DEPTH,
  FRESH_WINDOW.channelSteps,
);

function opsAfter(turn: number): string[] {
  const ops: string[] = [];
  if (turn === PLAN.pinAfter) ops.push("pin the combat passage (studio note)");
  if (turn === PLAN.midpointAfter) ops.push("session close (yokoku + Sakkan) → reopen (recap)");
  if (turn === PLAN.rewindAfter) {
    ops.push(
      `rewind ${PLAN.rewindDepth} turns (${PLAN.rewindAfter}→${PLAN.rewindAfter - PLAN.rewindDepth}), then re-climb — inside the ${PLAN.rewindDepth}-of-10 retake horizon (§6.7)`,
    );
  }
  return ops;
}

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
        // deliberate smoke-size: the soak's synthetic player persona, not a budget class.
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
  // Depth is measured from wherever the op fires, so a longer run rewinds the
  // same PLAYER-REACHABLE distance (§6.7's retake horizon), never a deeper one.
  const toTurn = Math.max(0, currentMax - PLAN.rewindDepth);
  const result = await rewindCampaign(
    db,
    campaignId,
    toTurn,
    `soak: rewind-of-${PLAN.rewindDepth} regression exercise`,
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
  const epochMerges = await epochEventCount(db, campaignId);

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
      // Epoch merges ride this row rather than getting a pass/fail of their
      // own: a 100-turn run is not expected to overflow Block 2's 8k ceiling,
      // so a required "epoch merged" gate would fail the soak for behaving.
      // Reported because when it DOES fire, the run's cache profile changes.
      detail: `${compactionRows.length} compacted beat(s), ${epochMerges} epoch merge(s)`,
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

function describePlan(fromTurn = 0, storyToPlay = PLAN.turns): string {
  const win = planWindow(fromTurn, storyToPlay, isChannelBeat);
  const lines: string[] = [];
  lines.push(
    `soak — ${storyToPlay}-STORY-turn scripted beat plan (DEV tiers: narration=${DEV_TIER_SELECTION.narration}, judgment=${DEV_TIER_SELECTION.judgment}, probe=${DEV_TIER_SELECTION.probe})`,
  );
  lines.push(
    `target ${storyToPlay} story turn(s) + ${win.channelSteps} scheduled channel step(s) = ${win.steps} submission(s), turns ${fromTurn + 1}..${win.windowEnd} · specials scripted at their own turns, gaps persona-driven (one probe/turn) · pin after ${PLAN.pinAfter} · session close/reopen after ${PLAN.midpointAfter} · rewind of ${PLAN.rewindDepth} after ${PLAN.rewindAfter}`,
  );
  const unreachable = Object.keys(SCRIPTED)
    .map(Number)
    .filter((n) => n > win.windowEnd || n <= fromTurn);
  if (unreachable.length > 0) {
    lines.push(
      `NOTE: specials at turn(s) ${unreachable.join(", ")} do not fire in this window — the event mix will be short by design`,
    );
  }
  // The structural ops scale with N and a small N genuinely drops some of them.
  // Said here, so the event-mix checklist's later "[ ] pin held" reads as a
  // planned absence rather than a failure the reader has to go diagnose.
  const dropped = droppedOps(PLAN);
  if (dropped.length > 0) {
    lines.push(
      `NOTE: op(s) DROPPED at N=${PLAN.turns} — ${dropped.join("; ")}; the event-mix checklist will show them unmet by design`,
    );
  }
  lines.push("");
  const width = String(win.windowEnd).length;
  for (let n = fromTurn + 1; n <= win.windowEnd; n++) {
    const s = SCRIPTED[n];
    const desc = s
      ? `${s.label}${s.channel ? " [CHANNEL — consumes a turn number, no scene]" : ""} — ${s.input}`
      : "persona — probe-driven laconic bounty-hunter move";
    lines.push(`  turn ${String(n).padStart(width, " ")}  ${desc}`);
    for (const op of opsAfter(n)) lines.push(`          ↳ op: ${op}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** What the invocation actually submitted, split the way the gate counts. */
interface RunTally {
  /** Completed STORY turns the CAMPAIGN holds at run end — the §10.3 quantity. */
  storyTurns: number;
  /** Channel steps this invocation submitted: turn numbers spent, no scenes. */
  channelSteps: number;
  /** Submissions this invocation made (story + channel + re-climb). */
  steps: number;
}

/** The §10.3 floor, stated against what the campaign now holds. Every report
 *  says it out loud: the N=50 run's 48 story turns read as a full run in the
 *  report while the gate suites silently skipped. */
function gateLine(tally: RunTally): string {
  const met = tally.storyTurns >= MIN_SOAK_TURNS;
  return `- Completed STORY turns in the campaign: **${tally.storyTurns}** vs the §10.3 gate floor of ${MIN_SOAK_TURNS} (flywheel-prospective \`MIN_SOAK_TURNS\`) — ${met ? "**MET**" : "**NOT MET — the gate suites will SKIP**"}. This invocation submitted ${tally.steps} step(s), of which ${tally.channelSteps} channel turn(s) consumed a turn number without writing a scene.`;
}

/** The per-turn table both the fresh report and the resume section print. */
function turnTableLines(records: TurnRecord[]): string[] {
  const out: string[] = [];
  out.push(
    "| step | turn | tier | served model | attempts | narration $ | turn $ | cacheRead frac | TTFT ms | total ms | flags |",
  );
  out.push("| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of records) {
    const frac = r.cacheReadFrac === null ? "—" : r.cacheReadFrac.toFixed(2);
    const ttft = r.ttftMs === null ? "—" : String(r.ttftMs);
    // Absent, not zero: a re-anchored turn's latency was never observed, and a
    // "0" in this column reads as an impossibly fast turn.
    const total = r.totalMs === null ? "—" : String(r.totalMs);
    const flags = [...r.failures.map((f) => `FAIL:${f}`), ...r.flags].join("; ") || "—";
    // Per-attempt spend, since the ceilings are asserted per attempt: a
    // multi-attempt turn's total is spend, not a cost-model reading.
    const attempts =
      r.attempts.length === 0
        ? "—"
        : r.attempts.map((a) => fmtUsd(a.usd)).join(" + ") +
          (r.attempts.length > 1 ? ` (${r.attempts.length})` : "");
    out.push(
      `| ${r.step} | ${r.turnNumber} | ${r.tier} | ${r.servedModel} | ${attempts} | ${fmtUsd(r.narrationUsd)} | ${fmtUsd(r.turnUsd)} | ${frac} | ${ttft} | ${total} | ${flags} |`,
    );
  }
  return out;
}

function buildReport(
  campaignId: string,
  records: TurnRecord[],
  checklist: ChecklistItem[],
  spend: SpendAttribution,
  coverage: MeteringCoverage,
  sessions: SessionCoverage,
  tally: RunTally,
): string {
  const out: string[] = [];
  out.push(`# Soak Report — ${PLAN.turns}-story-turn run`);
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("");
  out.push(
    `Campaign id: \`${campaignId}\` — **KEPT** for reference${CLEANUP ? " (but --cleanup will delete it after this report)" : " (pass --cleanup to delete)"}.`,
  );
  out.push("");
  out.push(
    `Tier selection (DEV): narration=\`${DEV_TIER_SELECTION.narration}\`, judgment=\`${DEV_TIER_SELECTION.judgment}\`, probe=\`${DEV_TIER_SELECTION.probe}\`. Fable guard: **PASS** (no Fable in any tier).`,
  );
  out.push("");

  out.push("## Story-turn count (the §10.3 gate quantity)");
  out.push("");
  out.push(gateLine(tally));
  out.push("");

  out.push("## Per-turn table");
  out.push("");
  out.push(...turnTableLines(records));
  out.push("");

  // The two coverage statements the M2 retro had to reconstruct by hand.
  out.push("## Assertion coverage (§10.8)");
  out.push("");
  for (const line of coverage.lines) out.push(`- ${line}`);
  out.push("");
  out.push("## Session-lifecycle coverage (§9.4)");
  out.push("");
  for (const line of sessions.lines) out.push(`- ${line}`);
  out.push("");

  out.push("## Event-mix checklist");
  out.push("");
  for (const c of checklist) out.push(`- ${c.ok ? "[x]" : "[ ]"} ${c.label} — ${c.detail}`);
  out.push("");

  out.push("## Totals + spend attribution");
  out.push("");
  const estimate = estimateRunPrice(PLAN.turns, DEV_TIER_SELECTION, SESSIONS, PLAN.channelBeats);
  out.push(
    `- Pre-run estimate (the number the run was authorized against): ${fmtUsd(estimate.warmFloorUsd)} floor · ${fmtUsd(estimate.expectedUsd)} expected · ${fmtUsd(estimate.coldCeilingUsd)} all-cold ceiling`,
  );
  out.push(`- Soak engine spend (all model calls, this campaign): **${fmtUsd(spend.totalUsd)}**`);
  out.push(`- Attributed to turns 1..N: ${fmtUsd(spend.attributedUsd)}`);
  out.push(
    `- Session/harness overhead (persona probes, pre-warm, startup, recap/yokoku/memo): ${fmtUsd(spend.overheadUsd)}`,
  );
  out.push(
    // TURN-TO-TURN, not within-turn: this mean is built from each turn's FIRST
    // narration call (soak-lib's `firstNarration`), which is the only call that
    // can prove the inter-turn prefix read. The within-turn read is a separate
    // meter — the §5.6 guaranteed-read floor in the failures list. The old
    // label read as if this number graded both, and it graded neither of the
    // 17 broken follow-ups the N=50 run actually contained.
    `- Measured turn-to-turn cache-read fraction (mean of each turn's FIRST narration call): ${spend.avgCacheReadFrac === null ? "n/a" : spend.avgCacheReadFrac.toFixed(2)} vs the ${BUDGET_ASSUMPTIONS.assumedCacheHitRate} assumption (§5.6)`,
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

/**
 * The INCREMENTAL report a `--campaign=` resume appends. The original report is
 * a record of the run that produced it and is never regenerated — and the gate
 * suites read the DATABASE, not this file, so the section's job is to tell a
 * reader what a later invocation added and whether the campaign now clears the
 * §10.3 floor.
 */
function buildResumeReport(
  campaignId: string,
  records: TurnRecord[],
  checklist: ChecklistItem[],
  coverage: MeteringCoverage,
  sessions: SessionCoverage,
  tally: RunTally,
  ctx: RunContext,
  incrementalUsd: number,
  sittingNote: string,
): string {
  const out: string[] = [];
  const played = records.filter((r) => r.status === "complete").length;
  out.push("");
  out.push(`## Resume ${new Date().toISOString().slice(0, 10)} — +${played} story turn(s)`);
  out.push("");
  out.push(
    `Appended by \`pnpm soak -- --campaign=${campaignId} --turns=${PLAN.turns}\` at ${new Date().toISOString()}. The report above is the original run's and is untouched.`,
  );
  out.push("");
  out.push(
    `- Before: **${ctx.existingStory}** completed story turn(s), highest turn number ${ctx.startTurn}. Short of the ${PLAN.turns}-story-turn target by ${ctx.toPlay}.`,
  );
  const turnNumbers = records.map((r) => r.turnNumber);
  const span =
    turnNumbers.length > 0
      ? `${Math.min(...turnNumbers)}..${Math.max(...turnNumbers)}`
      : "none — the loop played nothing";
  out.push(
    `- Played: ${records.length} submission(s) over turn(s) ${span} — ${played} story, ${records.filter((r) => r.status === "channel").length} channel.`,
  );
  out.push(`- Sitting: ${sittingNote}`);
  out.push(
    `- Incremental spend (every model call this invocation made): **${fmtUsd(incrementalUsd)}**`,
  );
  out.push(gateLine(tally));
  out.push("");

  out.push("### Per-turn table (resumed turns only)");
  out.push("");
  out.push(...turnTableLines(records));
  out.push("");

  out.push("### Assertion coverage (§10.8, resumed turns)");
  out.push("");
  for (const line of coverage.lines) out.push(`- ${line}`);
  out.push("");
  out.push("### Session-lifecycle coverage (§9.4, campaign-wide)");
  out.push("");
  for (const line of sessions.lines) out.push(`- ${line}`);
  out.push("");

  // The tier rows read THIS invocation's records; every other row is a
  // campaign-wide query. A two-turn resume that never draws a sakuga is not a
  // coverage miss, and the heading must not let it read as one.
  out.push("### Event-mix checklist (tier rows: the resumed turns only; the rest campaign-wide)");
  out.push("");
  for (const c of checklist) out.push(`- ${c.ok ? "[x]" : "[ ]"} ${c.label} — ${c.detail}`);
  out.push("");

  const allFailures = records.flatMap((r) => r.failures);
  const allFlags = records.flatMap((r) => r.flags.map((f) => `turn ${r.turnNumber}: ${f}`));
  out.push(`### Assertion failures (${allFailures.length})`);
  if (allFailures.length === 0) out.push("- none — every metered assertion held.");
  else for (const f of allFailures) out.push(`- ${f}`);
  out.push("");
  out.push(`### Waste-flags (${allFlags.length}) — §5.5: surfaced for review, never hard-fails`);
  if (allFlags.length === 0) out.push("- none.");
  else for (const f of allFlags) out.push(`- ${f}`);
  out.push("");

  out.push("### Beat plan (the resumed window)");
  out.push("");
  out.push("```");
  out.push(describePlan(ctx.startTurn, ctx.toPlay));
  out.push("```");
  out.push("");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

/** Where this invocation starts and how much of the target it owes. */
interface RunContext {
  /** True when `--campaign=` pointed the harness at an existing soak. */
  resume: boolean;
  /** The highest turn number already issued — play continues at +1. */
  startTurn: number;
  /** Completed story turns the campaign already holds. */
  existingStory: number;
  /** Story turns this invocation must play to reach the target. */
  toPlay: number;
  /** The turn-number window those story turns + scheduled channel beats span. */
  window: ReturnType<typeof planWindow>;
}

/** Everything this invocation spent on the campaign, bounded on the DATABASE
 *  clock — `attributeSpend` reads the campaign's whole history, which on a
 *  resume would bill the original run to the resumed turns. */
async function spendSince(db: Db, campaignId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ costUsd: schema.modelCalls.costUsd })
    .from(schema.modelCalls)
    .where(
      and(eq(schema.modelCalls.campaignId, campaignId), gte(schema.modelCalls.createdAt, since)),
    );
  return rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
}

async function liveRun(db: Db, campaignId: string, ctx: RunContext): Promise<void> {
  const records: TurnRecord[] = [];
  const artifacts: RunArtifacts = { session2Opened: false };
  const coldTurns = new Set<number>();
  let lastWatermark = 0;
  let lastEpochEvents = 0;
  const invocationSince = await dbNow(db);

  // Open the sitting. `resume: true` steps past the "closed explicitly, just
  // now" guard: the resumed turns MUST play inside a real sitting (M2 hole #4),
  // and a no-op open would leave every one of them outside the window.
  const opened = ctx.resume
    ? await openSession(db, campaignId, { resume: true })
    : await openSession(db, campaignId);
  // The first turn after a NEWLY-opened sitting reads a cold prefix — but a
  // resume into a still-open sitting (opened:false fires only under the 30-min
  // idle guard, strictly inside the 1h cache TTL) is genuinely WARM, and
  // pre-marking it cold would relabel a §5.6 zero-read regression as an
  // expected cold turn (review NIT, 2026-08-05). Known narrow edge, accepted:
  // a sitting opened but never played, resumed <30min later with the last real
  // turn >1h old, reads cold under a warm mark — that shape needs a played-turn
  // gap the harness's own plans never schedule.
  if (opened.opened) coldTurns.add(ctx.startTurn + 1);
  const sittingNote = opened.opened
    ? `sitting #${opened.sessionNumber} opened for the resumed turns`
    : `sitting #${opened.sessionNumber} was already open and carried the resumed turns`;
  console.log(
    ctx.resume
      ? `[soak] resume: ${sittingNote}`
      : `[soak] pilot session opened (session ${opened.sessionNumber}, pilot=${opened.pilot})`,
  );

  let turnNumber = ctx.startTurn;
  let step = 0;
  let tail = SOAK_OSP.director_inputs.opening_situation;
  if (ctx.resume) {
    // The persona picks the scene back up where the run left it. Seeding a
    // resume from the OPENING situation would have it walk back to the noodle
    // stand fifty turns in — a continuity break inside the very campaign the
    // §6.8 flywheel suites are about to grade.
    const [last] = await db
      .select({ narration: schema.turns.narration })
      .from(schema.turns)
      .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "complete")))
      .orderBy(desc(schema.turns.turnNumber))
      .limit(1);
    if (last?.narration?.trim()) tail = last.narration;
  }
  let didPin = false;
  let didMidpoint = false;
  let didRewind = false;
  let combatPassage = "";
  // A resume plays a short window; PLAN.maxSteps is sized for a whole run. Both
  // carry headroom for an unscripted turn the classifier routes to a channel.
  const MAX_STEPS = ctx.resume ? ctx.window.steps + 6 : PLAN.maxSteps;

  // The report writes NO MATTER HOW the loop ends (soak crash #1 lost run
  // data to an unhandled throw): abort reasons land in the report instead.
  let storyTurns = ctx.existingStory;
  let abort: string | null = null;
  try {
    while (step < MAX_STEPS) {
      // The target is completed STORY turns — what §10.3 counts, and what a
      // channel turn does not advance. Read from the database each pass so a
      // rewind's deleted spine rows subtract themselves and a resume starts
      // from the truth. (Found live 2026-08-05: a --turns=50 run played 50
      // NUMBERED turns, two of them booth/override channel turns, and banked 48
      // scenes — one short of the floor, so flywheel-prospective and
      // seed-integrity skipped the run they exist to feed.)
      storyTurns = await countStoryTurns(db, campaignId);
      if (storyTurns >= PLAN.turns) break;
      const intended = turnNumber + 1;
      const scripted = SCRIPTED[intended];

      // No turn plays outside a sitting (M2 hole #4: turns 10–24 played with
      // the sitting closed, and the run's session-lifecycle coverage was only
      // discovered to be uncertified in the retro). The guard is cheap — one
      // indexed read — and only ever opens when there is genuinely nothing open.
      if ((await openSittingNumber(db, campaignId)) === null) {
        console.warn("[soak] no open sitting before this turn — opening one");
        const reopened = await openSession(db, campaignId, { resume: true });
        coldTurns.add(intended);
        console.warn(`[soak] sitting ${reopened.sessionNumber} opened mid-run (coverage guard)`);
      }

      const input = scripted ? scripted.input : await personaMove(campaignId, tail);
      const label = scripted ? scripted.label : "persona";

      // DATABASE time, not the harness's: this bound filters `model_calls` by
      // their Postgres-stamped `created_at`, and a laptop clock running ahead
      // would drop the turn's own ledger rows and report a lost row.
      const since = await dbNow(db);
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
          // That turn settled on its OWN — it consumed this beat and its spend
          // is real. M2's turn 9 took exactly this route and was never metered
          // or asserted, while the run reported full coverage. Meter it from
          // the durable record, re-anchor, and let the loop re-derive the beat.
          step += 1;
          const [settledRow] = await db
            .select({ turnNumber: schema.turns.turnNumber })
            .from(schema.turns)
            .where(eq(schema.turns.id, err.pendingTurnId));
          if (settledRow) {
            const rec = await meterSettledTurn(
              db,
              campaignId,
              settledRow.turnNumber,
              step,
              `${label} (re-anchored)`,
              coldTurns,
            );
            if (rec) {
              records.push(rec);
              turnNumber = Math.max(turnNumber, settledRow.turnNumber);
              console.warn(
                `[soak] re-anchored on turn ${settledRow.turnNumber} — metered from the record (${fmtUsd(rec.narrationUsd)})`,
              );
              continue;
            }
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

      // A compaction event wholesale-resets B2 + the window (sanctioned, §6.2)
      // — the NEXT turn's first read is legitimately cold, same as a session
      // open (C3 audit symmetry; without this it survives only via B1's
      // frozen-Settei partial read).
      const wm = await compactionWatermark(db, campaignId);
      if (wm > lastWatermark) {
        coldTurns.add(turnNumber + 1);
        lastWatermark = wm;
      }
      // An EPOCH MERGE is the same sanctioned invalidation from the other end
      // (M3 C3): it rewrites Block 2 wholesale but leaves the watermark exactly
      // where it was — the epoch inherits its span's `toTurn` — so the check
      // above cannot see it. Without this the next turn reads as a warm turn
      // that mysteriously lost its B2 prefix, i.e. a soak failure for doing
      // precisely what §6.2 asks.
      const epochs = await epochEventCount(db, campaignId);
      if (epochs > lastEpochEvents) {
        coldTurns.add(turnNumber + 1);
        lastEpochEvents = epochs;
      }

      const record = await meterTurn(db, campaignId, run, step, label, since, coldTurns);
      records.push(record);
      if (record.tier === "sakuga" && !combatPassage) combatPassage = run.prose;
      if (run.prose.trim()) tail = run.prose;

      console.log(
        `[soak] step ${step} · turn ${turnNumber} · ${record.tier} · ${record.status} · narration ${fmtUsd(record.narrationUsd)} · ttft ${record.ttftMs ?? "—"}ms${record.failures.length ? ` · FAIL(${record.failures.length})` : ""}`,
      );

      // --- Ops, keyed to the intended turn number (before any rewind re-climb) ---
      if (intended === PLAN.pinAfter && !didPin) {
        await pinPassage(db, campaignId, turnNumber, combatPassage || run.prose);
        didPin = true;
        console.log(`[soak] pinned a passage from turn ${turnNumber}`);
      }
      if (intended === PLAN.midpointAfter && !didMidpoint) {
        const closed = await closeSession(db, campaignId, "explicit");
        artifacts.yokoku = closed.yokoku;
        await settleG2IfPending(db, campaignId);
        // RESUME, deliberately (N=50 soak, event-mix miss): the M2R R3 guard
        // refuses a reopen inside the idle window after an EXPLICIT close —
        // correctly, since a player reloading the page must not burn a whole
        // open sequence. The scripted midpoint is the deliberate resume that
        // guard exists to require, and without the flag the run reported
        // "session close + reopen" as an uncovered event: session 2 opened
        // later, from the coverage guard, with no recap.
        const reopened = await openSession(db, campaignId, { resume: true });
        artifacts.session2Opened = reopened.opened;
        artifacts.recap = reopened.recap;
        coldTurns.add(turnNumber + 1); // session 2's first turn is cold again
        didMidpoint = true;
        console.log(
          `[soak] midpoint: session closed (yokoku ${closed.yokoku ? "yes" : "no"}) → reopened (recap ${reopened.recap ? "yes" : "no"})`,
        );
      }
      if (intended === PLAN.rewindAfter && !didRewind) {
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

  storyTurns = await countStoryTurns(db, campaignId);
  const tally: RunTally = {
    storyTurns,
    channelSteps: records.filter((r) => r.status === "channel").length,
    steps: step,
  };
  const checklist = await buildChecklist(db, campaignId, records, artifacts);
  const spend = await attributeSpend(db, campaignId, records, SESSIONS);
  // A resume claims only the turns it played (§10.8 coverage is per invocation).
  const coverage = meteringCoverage(records, turnNumber, ctx.startTurn + 1);
  const sessions = await sessionCoverage(db, campaignId);

  // Named by N: a 100-turn M3 gate run must never overwrite the M1 retro that
  // records a different run at a different depth. A resume APPENDS — the
  // original report describes the run that produced it, and the gate suites
  // read the database, not this file.
  const reportPath = join(process.cwd(), "docs", "retros", `soak-${PLAN.turns}turn.md`);
  if (ctx.resume) {
    const incrementalUsd = await spendSince(db, campaignId, invocationSince);
    let section = buildResumeReport(
      campaignId,
      records,
      checklist,
      coverage,
      sessions,
      tally,
      ctx,
      incrementalUsd,
      sittingNote,
    );
    if (abort) {
      section += `\n### ABORTED\n\n${abort}\n`;
      console.error(`[soak] ABORTED: ${abort}`);
    }
    const target = existsSync(reportPath)
      ? reportPath
      : join(process.cwd(), "docs", "retros", `soak-${PLAN.turns}turn-resume.md`);
    if (target === reportPath) {
      appendFileSync(target, section);
    } else {
      writeFileSync(
        target,
        `# Soak Resume Report — ${PLAN.turns}-story-turn target\n\nNo \`soak-${PLAN.turns}turn.md\` existed to append to; this file carries the incremental record.\n${section}`,
      );
    }
    console.log(`\n[soak] resume report appended → ${target}`);
  } else {
    let report = buildReport(campaignId, records, checklist, spend, coverage, sessions, tally);
    if (abort) {
      report += `\n## ABORTED\n\n${abort}\n`;
      console.error(`[soak] ABORTED: ${abort}`);
    }
    writeFileSync(reportPath, report);
    console.log(`\n[soak] report → ${reportPath}`);
  }

  // Console summary.
  const misses = checklist.filter((c) => !c.ok);
  const failures = records.flatMap((r) => r.failures);
  console.log("\n=== SOAK SUMMARY ===");
  console.log(
    `story turns banked: ${storyTurns}/${PLAN.turns} (§10.3 floor ${MIN_SOAK_TURNS} — ${storyTurns >= MIN_SOAK_TURNS ? "MET" : "NOT MET"}) · channel steps this run: ${tally.channelSteps}`,
  );
  console.log(
    `turns reached: ${turnNumber} · steps: ${step} · total spend ${fmtUsd(spend.totalUsd)}`,
  );
  console.log(
    `event mix: ${checklist.length - misses.length}/${checklist.length} landed${misses.length ? ` (missing: ${misses.map((m) => m.label).join(", ")})` : ""}`,
  );
  console.log(`assertion failures: ${failures.length}`);
  for (const line of coverage.lines) console.log(`  coverage: ${line}`);
  for (const line of sessions.lines) console.log(`  sittings: ${line}`);
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

/**
 * `--campaign=<uuid>`: verify, do the arithmetic, price ONLY the turns this
 * invocation adds, then play them. Every read here is a database read — the
 * price still prints before the first model call, which is the rule the
 * standing gate is actually about.
 */
async function resumeMain(campaignId: string): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[soak] FATAL: --campaign needs DATABASE_URL — the campaign lives in the DB");
    process.exit(1);
  }
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.campaigns.id,
      title: schema.campaigns.title,
      status: schema.campaigns.status,
      openingPackage: schema.campaigns.openingPackage,
    })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  const verdict = assertSoakCampaign(row, campaignId);
  if (!verdict.ok) {
    console.error(`[soak] FATAL: ${verdict.reason}`);
    process.exit(1);
  }

  const existingStory = await countStoryTurns(db, campaignId);
  const startTurn = await maxTurnNumber(db, campaignId);
  const { toPlay, window } = resumePlan(existingStory, PLAN.turns, startTurn, isChannelBeat);
  console.log(
    `[soak] resume · campaign ${campaignId} ("${verdict.row.title}") holds ${existingStory} completed story turn(s) at max turn number ${startTurn}`,
  );
  console.log(
    `[soak] resume · target ${PLAN.turns} → ${toPlay} story turns to play (${window.channelSteps} scheduled channel step(s); turn numbers ${startTurn + 1}..${window.windowEnd}) · §10.3 floor ${MIN_SOAK_TURNS}`,
  );
  if (toPlay === 0) {
    console.log(
      `[soak] resume: nothing to play — the campaign already carries ${existingStory} ≥ ${PLAN.turns} completed story turns. No sitting opened, no spend.`,
    );
    return;
  }

  // Prices only the INCREMENTAL turns.
  const estimate = estimateRunPrice(toPlay, DEV_TIER_SELECTION, SESSIONS, window.channelSteps);
  for (const line of estimate.lines) console.log(line);
  console.log("");
  console.log(describePlan(startTurn, toPlay));
  console.log("");

  if (DRY_RUN) {
    console.log(
      "[dry-run] resume arithmetic printed — ZERO model calls, no sitting opened, no turns submitted, campaign untouched.",
    );
    return;
  }

  const ctx: RunContext = { resume: true, startTurn, existingStory, toPlay, window };
  try {
    await liveRun(db, campaignId, ctx);
  } finally {
    await flushLangfuse();
    console.log(`[soak] campaign ${campaignId} KEPT (a resume never deletes what it resumed).`);
  }
}

async function main(): Promise<void> {
  guardNoFable(DEV_TIER_SELECTION);

  if (RESUME_CAMPAIGN) {
    await resumeMain(RESUME_CAMPAIGN);
    return;
  }

  // The price BEFORE anything else, dry-run included: the user prices a run and
  // then authorizes it, never the other way round (§0.9 / the standing gate).
  const estimate = estimateRunPrice(PLAN.turns, DEV_TIER_SELECTION, SESSIONS, PLAN.channelBeats);
  for (const line of estimate.lines) console.log(line);
  console.log("");

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
  const ctx: RunContext = {
    resume: false,
    startTurn: 0,
    existingStory: 0,
    toPlay: PLAN.turns,
    window: FRESH_WINDOW,
  };
  try {
    await liveRun(db, campaignId, ctx);
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
