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
 *
 * Standing directive: DEV traffic runs Sonnet/Haiku (DEV_TIER_SELECTION);
 * NO automated run ever calls Fable. A hard guard at startup exits loudly if
 * any selected model is a Fable variant. (The spend-attribution projection
 * DOES price a hypothetical Fable session — that is pure `estimateCostUsd`
 * arithmetic on measured usage, never an API call.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
import { and, desc, eq } from "drizzle-orm";
import jsYaml from "js-yaml";
import { z } from "zod";
import { BUDGET_ASSUMPTIONS } from "../evals/suites/budget-assertions";
import {
  BEBOP_OSP,
  type MeteringCoverage,
  type SessionCoverage,
  type SoakPlan,
  type SpendAttribution,
  type TurnRecord,
  type TurnRun,
  attributeSpend,
  buildSoakPlan,
  dbNow,
  droppedOps,
  estimateRunPrice,
  fmtUsd,
  guardNoFable,
  meterSettledTurn,
  meterTurn,
  meteringCoverage,
  openSittingNumber,
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

/** `--turns=N` (default 30, the M1 shape). The M3 gate runs 100 (§10.3 asks
 *  50–100; the M2 gate ran 24 against that letter — a recorded discrepancy). */
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

const TARGET_TURNS = parseTurns(process.argv);

/** How many turns a nominal play sitting is, for the spend projection. */
const SESSIONS = 2;
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

/** Ops fire AFTER the intended turn lands, once each. The pin rides the combat
 *  special, so it keeps that special's turn; the midpoint and the rewind are
 *  structural and scale with N (buildSoakPlan). */
const PIN_AFTER_TURN = 8;
const REWIND_DEPTH = 2;
const PLAN: SoakPlan = buildSoakPlan(TARGET_TURNS, PIN_AFTER_TURN, REWIND_DEPTH);

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

function describePlan(): string {
  const lines: string[] = [];
  lines.push(
    `soak — ${PLAN.turns}-turn scripted beat plan (DEV tiers: narration=${DEV_TIER_SELECTION.narration}, judgment=${DEV_TIER_SELECTION.judgment}, probe=${DEV_TIER_SELECTION.probe})`,
  );
  lines.push(
    `target ${PLAN.turns} turns · specials scripted at their own turns, gaps persona-driven (one probe/turn) · pin after ${PLAN.pinAfter} · session close/reopen after ${PLAN.midpointAfter} · rewind of ${PLAN.rewindDepth} after ${PLAN.rewindAfter}`,
  );
  const unreachable = Object.keys(SCRIPTED)
    .map(Number)
    .filter((n) => n > PLAN.turns);
  if (unreachable.length > 0) {
    lines.push(
      `NOTE: specials at turn(s) ${unreachable.join(", ")} never fire at N=${PLAN.turns} — the event mix will be short by design`,
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
  const width = String(PLAN.turns).length;
  for (let n = 1; n <= PLAN.turns; n++) {
    const s = SCRIPTED[n];
    const desc = s
      ? `${s.label} — ${s.input}`
      : "persona — probe-driven laconic bounty-hunter move";
    lines.push(`  turn ${String(n).padStart(width, " ")}  ${desc}`);
    for (const op of opsAfter(n)) lines.push(`          ↳ op: ${op}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(
  campaignId: string,
  records: TurnRecord[],
  checklist: ChecklistItem[],
  spend: SpendAttribution,
  coverage: MeteringCoverage,
  sessions: SessionCoverage,
): string {
  const out: string[] = [];
  out.push(`# Soak Report — ${PLAN.turns}-turn run`);
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

  out.push("## Per-turn table");
  out.push("");
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
  const estimate = estimateRunPrice(PLAN.turns, DEV_TIER_SELECTION, SESSIONS);
  out.push(
    `- Pre-run estimate (the number the run was authorized against): ${fmtUsd(estimate.warmFloorUsd)} floor · ${fmtUsd(estimate.expectedUsd)} expected · ${fmtUsd(estimate.coldCeilingUsd)} all-cold ceiling`,
  );
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
  let lastWatermark = 0;
  let lastEpochEvents = 0;

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
  const MAX_STEPS = PLAN.maxSteps; // re-climb headroom + safety

  // The report writes NO MATTER HOW the loop ends (soak crash #1 lost run
  // data to an unhandled throw): abort reasons land in the report instead.
  let abort: string | null = null;
  try {
    while (turnNumber < PLAN.turns && step < MAX_STEPS) {
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
        const reopened = await openSession(db, campaignId);
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

  const checklist = await buildChecklist(db, campaignId, records, artifacts);
  const spend = await attributeSpend(db, campaignId, records, SESSIONS);
  const coverage = meteringCoverage(records, turnNumber);
  const sessions = await sessionCoverage(db, campaignId);
  let report = buildReport(campaignId, records, checklist, spend, coverage, sessions);
  if (abort) {
    report += `\n## ABORTED\n\n${abort}\n`;
    console.error(`[soak] ABORTED: ${abort}`);
  }

  // Named by N: a 100-turn M3 gate run must never overwrite the M1 retro that
  // records a different run at a different depth.
  const reportPath = join(process.cwd(), "docs", "retros", `soak-${PLAN.turns}turn.md`);
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

async function main(): Promise<void> {
  guardNoFable(DEV_TIER_SELECTION);

  // The price BEFORE anything else, dry-run included: the user prices a run and
  // then authorizes it, never the other way round (§0.9 / the standing gate).
  const estimate = estimateRunPrice(PLAN.turns, DEV_TIER_SELECTION, SESSIONS);
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
