/**
 * M2-C10 — the drift soak (blueprint §12 M2 gate; plan M2-method-depth C10).
 * Scripted turns engineered DENSE with register temptation — genre gravity,
 * tonal bait, escalation pressure — driven through the REAL turn loop with
 * Sakkan v2 measuring throughout.
 *
 * PASS =
 *   (a) drift stays inside the §4.5 band across every real sample
 *       (|effective − observed| < DRIFT_THRESHOLD at scoring confidence), and
 *   (b) corrections demonstrably punch through when pushed outside: a FORCED
 *       out-of-band retake (synthetic Sakkan note injected mid-run — the live
 *       amendments/punch-through circuit, synthetic trigger) expires within
 *       one NOTED interval (§4.5's accelerated re-read).
 *
 * §0.9 discipline: the soak CERTIFIES fixture-tuned behavior, never explores;
 * and it RESUMES its persisted campaign after a crash instead of re-buying
 * turns (`--resume` picks up at the first un-run beat; scripted beats are
 * keyed by turn number, so resume is deterministic).
 *
 *   pnpm drift-soak                LIVE run (user-gated spend) → docs/retros/M2-drift-soak.md
 *   pnpm drift-soak -- --dry-run   prints the beat plan, seeds + tears down, ZERO model calls
 *   pnpm drift-soak -- --resume    continue the persisted soak campaign after a crash
 *
 * DEV tiers only (Sonnet narration); the Fable guard aborts otherwise.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { settleG2IfPending } from "@/lib/compositor/g2";
import { type Db, getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadDirectionState, saveDirectionState } from "@/lib/direction/director";
import { closeSession, openSession } from "@/lib/direction/session";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import {
  DRIFT_CONFIDENCE,
  DRIFT_CONSECUTIVE,
  DRIFT_THRESHOLD,
  SAKKAN_NOTED_INTERVAL_TURNS,
} from "@/lib/sakkan/sakkan";
import { TurnInProgressError, executeTurn } from "@/lib/turn/runtime";
import { OpeningStatePackage } from "@/lib/types/opening";
import { and, desc, eq } from "drizzle-orm";
import {
  BEBOP_OSP,
  type DriftGate,
  type TurnRecord,
  attributeSpend,
  classifyAxisVerdict,
  fmtUsd,
  guardNoFable,
  meterTurn,
  runOneTurn,
  waitForRowTerminal,
} from "./soak-lib";

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");

const TITLE = "M2 Drift Soak — Cowboy Bebop";
const TARGET_TURNS = 24;
/** The forced punch-through arm injects AFTER this turn settles. */
const FORCE_AFTER_TURN = 16;
/** The injected retake: bebop's darkness runs 7; a 4 reads 3 off — out of band. */
const FORCED_AXIS = "darkness";
const FORCED_OBSERVED = 4;
/** One sitting — the drift soak certifies the register, not session mechanics. */
const SESSIONS = 1;

// ---------------------------------------------------------------------------
// The temptation beat plan. EVERY turn carries register pressure (§0.9: a
// dense 24 buys what a padded 30 would). Classes: genre-gravity (shonen
// escalation bait), tonal-bait (melodrama / comedy / grimdark pulls),
// escalation-pressure (stakes inflation, power fantasy). The bait lives in
// the PLAYER INPUT — the narrator is invited to break register; the Sakkan
// measures whether it does.
// ---------------------------------------------------------------------------

interface TemptationBeat {
  input: string;
  label: string;
  class: "genre-gravity" | "tonal-bait" | "escalation-pressure" | "baseline";
}

const BEATS: Record<number, TemptationBeat> = {
  1: {
    class: "baseline",
    label: "cold open (baseline read)",
    input:
      "I close out the shift, kill the dock floods, and walk toward the noodle stand where the bounty was last seen.",
  },
  2: {
    class: "genre-gravity",
    label: "power-up bait",
    input:
      "Some nights I swear there's something sleeping in me — a power waiting for the right moment. I clench my fist and try to feel it wake.",
  },
  3: {
    class: "tonal-bait",
    label: "melodrama bait",
    input:
      "The rain gets heavier. I think about everyone I've ever lost, one by one, and let it show on my face for once. All of it.",
  },
  4: {
    class: "escalation-pressure",
    label: "stakes inflation",
    input:
      'I tell the fixer straight: "This job isn\'t about money anymore. This is bigger than the docks. Bigger than the whole system, maybe."',
  },
  5: {
    class: "genre-gravity",
    label: "named-attack bait",
    input:
      "I practice my quick-draw against the mirror and give the move a name, saying it out loud like it means something.",
  },
  6: {
    class: "genre-gravity",
    label: "sakuga combat + tournament framing",
    input:
      "Three of them block the gantry. I crack my knuckles and tell them we do this one at a time — a real tournament of it. Then I move first.",
  },
  7: {
    class: "tonal-bait",
    label: "comedy pull",
    input:
      "I slip on the wet grating mid-stride and try to play it off cool in front of the noodle vendor, who definitely saw everything.",
  },
  8: {
    class: "escalation-pressure",
    label: "power-fantasy bait",
    input:
      "I walk into the bar slow, letting every head turn. They should all feel it — that the strongest person in the room just arrived.",
  },
  9: {
    class: "tonal-bait",
    label: "grimdark pull",
    input:
      "I find the man who sold out the mark. I want him to understand fear before we talk. Really understand it.",
  },
  10: {
    class: "genre-gravity",
    label: "training-arc bait",
    input:
      "Maybe I've gotten soft. I start a regimen right there on the dock — reps until sunrise, whatever it takes to reach the next level.",
  },
  11: {
    class: "tonal-bait",
    label: "tragic-backstory dump bait",
    input:
      "Over cheap whiskey I tell Mireille the whole story — the war, the betrayal, the person I used to be. Every wound, in order.",
  },
  12: {
    class: "escalation-pressure",
    label: "villain-monologue invitation",
    input:
      "I let the fixer's boss corner me on the catwalk. If he wants to explain his grand design for the docks, I'll let him talk.",
  },
  13: {
    class: "genre-gravity",
    label: "charge-up bait",
    input:
      "I close my eyes, center everything I have, and focus it into one strike — taking all the time the moment will give me.",
  },
  14: {
    class: "tonal-bait",
    label: "sentiment bait (found family)",
    input:
      "Back on the trawler, I look around at the crew eating together and almost say what they mean to me. Almost.",
  },
  15: {
    class: "escalation-pressure",
    label: "fate-of-everything bait",
    input:
      "The manifest says the cargo could burn the whole port down. Maybe the city. I say it out loud so everyone understands what's at stake now.",
  },
  16: {
    class: "genre-gravity",
    label: "rival-declaration bait",
    input:
      'The bounty finally faces me on the pier. I point at him: "You and me. This was always going to happen. Destiny, maybe."',
  },
  17: {
    class: "baseline",
    label: "quiet beat under the forced retake",
    input: "I sit on the trawler's rail and watch the harbor lights. Nothing needs saying.",
  },
  18: {
    class: "tonal-bait",
    label: "melodrama bait under retake",
    input:
      "Mireille asks if I'm okay. I could tell her everything — let the whole dam break right here in the galley.",
  },
  19: {
    class: "genre-gravity",
    label: "power-reveal bait under retake",
    input:
      "The dockhands whisper about what I did on the pier. I let the legend grow a little. Maybe I show them a taste.",
  },
  20: {
    class: "genre-gravity",
    label: "sakuga combat under pressure",
    input:
      "The warehouse door blows. I go in through the smoke, low and fast — whoever's left standing answers my questions.",
  },
  21: {
    class: "escalation-pressure",
    label: "sequel-hook inflation",
    input:
      '"This was just the beginning," I tell the crew. "Whoever\'s behind the manifest is playing a longer game. A much bigger one."',
  },
  22: {
    class: "tonal-bait",
    label: "comedy pull (late)",
    input:
      "The vending machine eats my last woolong. I have a genuine standoff with it. The machine is winning.",
  },
  23: {
    class: "genre-gravity",
    label: "timeskip/growth bait",
    input:
      "I tell myself that after this job, everything changes — new ship, new name, a whole new arc of my life.",
  },
  24: {
    class: "baseline",
    label: "closing beat (final read)",
    input:
      "I finish the paperwork on the bounty, pocket what's left after fees, and let the night have the rest.",
  },
};

// ---------------------------------------------------------------------------
// Sakkan snapshots: after every settled turn, read the drift band's state.
// ---------------------------------------------------------------------------

interface SampleSnapshot {
  afterTurn: number;
  lastSampleTurn: number;
  readings: {
    axis: string;
    observed: number;
    confidence: number;
    atTurn: number;
    effective: number;
    delta: number;
    inBand: boolean;
    consecutiveDrift: number;
  }[];
  activeNotes: { axis: string; sinceTurn: number }[];
  /** §4.5 M2R3 — axes the gate-trip attribution charged to the player (retake closed). */
  playerDrivenAxes: string[];
}

/** The premise the Sakkan measures against: active ⊕ arc_override (§4.2) —
 *  mirroring runSakkanSample so the harness band math can never silently
 *  diverge from what the engine actually measured (audit). */
async function effectiveTreatment(db: Db, campaignId: string): Promise<Record<string, number>> {
  const [campaign] = await db
    .select({ arcOverride: schema.campaigns.arcOverride })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  const base = bebopContract().active.treatment as unknown as Record<string, number>;
  const override = (campaign?.arcOverride ?? null) as { dna?: Record<string, number> } | null;
  return { ...base, ...(override?.dna ?? {}) };
}

async function snapshotSakkan(
  db: Db,
  campaignId: string,
  afterTurn: number,
): Promise<SampleSnapshot> {
  const state = await loadDirectionState(db, campaignId);
  const effective = await effectiveTreatment(db, campaignId);
  const readings = Object.entries(state.sakkan?.readings ?? {}).map(([axis, r]) => {
    const eff = effective[axis] ?? 5;
    const delta = Math.abs(eff - r.observed);
    return {
      axis,
      observed: r.observed,
      confidence: r.confidence,
      atTurn: r.at_turn,
      effective: eff,
      delta,
      inBand: delta < DRIFT_THRESHOLD,
      consecutiveDrift: r.consecutive_drift,
    };
  });
  return {
    afterTurn,
    lastSampleTurn: state.sakkan?.last_sample_turn ?? 0,
    readings,
    activeNotes: (state.sakkan?.active_notes ?? []).map((n) => ({
      axis: n.axis,
      sinceTurn: n.since_turn,
    })),
    playerDrivenAxes: Object.keys(state.sakkan?.player_driven ?? {}),
  };
}

/** The forced punch-through arm: inject a synthetic out-of-band retake. */
async function injectForcedNote(db: Db, campaignId: string, atTurn: number): Promise<void> {
  const state = await loadDirectionState(db, campaignId);
  const effective = await effectiveTreatment(db, campaignId);
  const active = effective[FORCED_AXIS] ?? 7;
  const sakkan = state.sakkan ?? {
    last_sample_turn: 0,
    readings: {},
    active_notes: [],
    player_driven: {},
  };
  sakkan.active_notes = [
    ...sakkan.active_notes.filter((n) => n.axis !== FORCED_AXIS),
    { axis: FORCED_AXIS, active, observed: FORCED_OBSERVED, since_turn: atTurn },
  ];
  await saveDirectionState(db, campaignId, { ...state, sakkan });
  console.log(
    `[drift-soak] FORCED ARM: injected out-of-band retake on '${FORCED_AXIS}' (active ${active}, observed ${FORCED_OBSERVED}) at turn ${atTurn} — the amendments must escalate and the note must expire within ${SAKKAN_NOTED_INTERVAL_TURNS} turns`,
  );
}

// ---------------------------------------------------------------------------
// Seed / resume
// ---------------------------------------------------------------------------

async function seedOrResume(db: Db): Promise<{ campaignId: string; resumedFrom: number }> {
  if (RESUME) {
    const [existing] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.title, TITLE))
      .orderBy(desc(schema.campaigns.createdAt))
      .limit(1);
    if (existing) {
      const [last] = await db
        .select({ turnNumber: schema.turns.turnNumber })
        .from(schema.turns)
        .where(and(eq(schema.turns.campaignId, existing.id), eq(schema.turns.status, "complete")))
        .orderBy(desc(schema.turns.turnNumber))
        .limit(1);
      const resumedFrom = last?.turnNumber ?? 0;
      console.log(`[drift-soak] RESUME: campaign ${existing.id} at turn ${resumedFrom}`);
      return { campaignId: existing.id, resumedFrom };
    }
    console.warn("[drift-soak] --resume found no prior campaign — seeding fresh");
  }
  const playerId = `soak_player_${crypto.randomUUID()}`;
  await db
    .insert(schema.players)
    .values({ id: playerId, email: "drift-soak@example.com" })
    .onConflictDoNothing();
  const osp = OpeningStatePackage.parse(BEBOP_OSP);
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      playerId,
      title: TITLE,
      status: "active",
      premiseContract: bebopContract(),
      openingPackage: osp,
      tierModels: DEV_TIER_SELECTION,
    })
    .returning({ id: schema.campaigns.id });
  if (!campaign) throw new Error("[drift-soak] campaign seed failed");
  return { campaignId: campaign.id, resumedFrom: 0 };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function describePlan(): string {
  const lines = [
    `M2 drift soak — ${TARGET_TURNS} temptation beats (DEV tiers: narration=claude-sonnet-5) · forced retake after turn ${FORCE_AFTER_TURN} on '${FORCED_AXIS}'`,
    "",
  ];
  for (let n = 1; n <= TARGET_TURNS; n++) {
    const b = BEATS[n];
    if (b) lines.push(`  turn ${String(n).padStart(2, " ")}  [${b.class}] ${b.label}`);
  }
  return lines.join("\n");
}

interface Verdict {
  bandHeld: boolean;
  /** Axes whose FINAL reading drifts at the engine's own triple gate
   *  (threshold + confidence + consecutive) — sustained, uncorrected. */
  uncorrected: { axis: string; atTurn: number; delta: number }[];
  /** Axes that drifted out and were pulled back — the machinery WORKING. */
  corrected: { axis: string; outAt: number; backInAt: number }[];
  /** §4.5 M2R3: axes that ended engaged but whose drift the gate-trip attribution
   *  charged to the PLAYER (retake closed) — escalated to steering honesty, NOT
   *  a fail. The box the M2 soak lacked. */
  escalated: { axis: string; atTurn: number; delta: number }[];
  /** Final-read excursions BELOW the consecutive trigger — the correction
   *  machinery was never due; neither pass nor fail, reported forward. */
  unresolved: { axis: string; atTurn: number; delta: number; consecutive: number }[];
  forced: {
    injectedAt: number | null;
    expiredBySample: number | null;
    withinNotedInterval: boolean | null;
  };
}

function computeVerdict(snapshots: SampleSnapshot[], injectedAt: number | null): Verdict {
  // §4.5's own semantics, at ENGINE parity (audit): the gate fails on
  // UNCORRECTED drift — an axis whose FINAL reading drifts (delta ≥
  // DRIFT_THRESHOLD at conf ≥ DRIFT_CONFIDENCE) with consecutive_drift ≥
  // DRIFT_CONSECUTIVE, the same triple gate that fires the engine's retake.
  // A final-read excursion BELOW the consecutive trigger is a distinct
  // "unresolved at run end" class: the correction machinery was never due,
  // so it neither passes nor fails — it is reported for the next run.

  // The forced arm first: find where the injected note was OBSERVED active
  // and where it expired. Expiry only counts if the note was actually seen
  // active in a snapshot — a lost injection write must not pass vacuously.
  let observedActive = false;
  let expiredBySample: number | null = null;
  if (injectedAt !== null) {
    for (const snap of snapshots) {
      if (snap.afterTurn <= injectedAt) continue;
      const stillActive = snap.activeNotes.some((n) => n.axis === FORCED_AXIS);
      if (stillActive) observedActive = true;
      const sampledSince = snap.lastSampleTurn > injectedAt;
      if (observedActive && sampledSince && !stillActive) {
        expiredBySample = snap.lastSampleTurn;
        break;
      }
    }
  }

  interface Point {
    atTurn: number;
    delta: number;
    confidence: number;
    consecutiveDrift: number;
  }
  const byAxis = new Map<string, Point[]>();
  for (const snap of snapshots) {
    for (const r of snap.readings) {
      // The forced axis is excluded ONLY while the synthetic note lives —
      // once it expires, darkness rejoins the natural-band verdict (audit:
      // an unbounded window left the gate blind on one axis for a third
      // of the run).
      if (
        injectedAt !== null &&
        r.axis === FORCED_AXIS &&
        snap.afterTurn > injectedAt &&
        (expiredBySample === null || snap.lastSampleTurn <= expiredBySample)
      ) {
        continue;
      }
      const seq = byAxis.get(r.axis) ?? [];
      if (!seq.some((x) => x.atTurn === r.atTurn)) {
        seq.push({
          atTurn: r.atTurn,
          delta: r.delta,
          confidence: r.confidence,
          consecutiveDrift: r.consecutiveDrift,
        });
      }
      byAxis.set(r.axis, seq);
    }
  }
  const drifting = (x: Point) => x.delta >= DRIFT_THRESHOLD && x.confidence >= DRIFT_CONFIDENCE;
  const gate: DriftGate = {
    threshold: DRIFT_THRESHOLD,
    confidence: DRIFT_CONFIDENCE,
    consecutive: DRIFT_CONSECUTIVE,
  };
  // Which axes ended charged to the player (§4.5 M2R3): read the LAST snapshot
  // that carried real readings — an axis engaged there but in the player-driven
  // set is escalated, never a fail (the M2 continuity ambiguity's exit).
  const finalPlayerDriven = new Set<string>(
    [...snapshots].reverse().find((s) => s.readings.length > 0)?.playerDrivenAxes ?? [],
  );
  const uncorrected: Verdict["uncorrected"] = [];
  const corrected: Verdict["corrected"] = [];
  const escalated: Verdict["escalated"] = [];
  const unresolved: Verdict["unresolved"] = [];
  for (const [axis, seq] of byAxis) {
    seq.sort((a, b) => a.atTurn - b.atTurn);
    const last = seq[seq.length - 1];
    if (!last) continue;
    const cls = classifyAxisVerdict(seq, gate, finalPlayerDriven.has(axis));
    if (cls === "uncorrected") {
      uncorrected.push({ axis, atTurn: last.atTurn, delta: last.delta });
    } else if (cls === "player_driven") {
      escalated.push({ axis, atTurn: last.atTurn, delta: last.delta });
    } else if (cls === "unresolved") {
      unresolved.push({
        axis,
        atTurn: last.atTurn,
        delta: last.delta,
        consecutive: last.consecutiveDrift,
      });
    } else if (cls === "corrected") {
      const events = seq.filter(drifting);
      const firstOut = events[0];
      const backIn = seq.find((x) => x.atTurn > (firstOut?.atTurn ?? 0) && !drifting(x));
      corrected.push({
        axis,
        outAt: firstOut?.atTurn ?? 0,
        backInAt: backIn?.atTurn ?? last.atTurn,
      });
    }
    // "clean" → no entry.
  }
  return {
    bandHeld: uncorrected.length === 0,
    uncorrected,
    corrected,
    escalated,
    unresolved,
    forced: {
      injectedAt,
      expiredBySample,
      withinNotedInterval:
        injectedAt === null || expiredBySample === null
          ? injectedAt === null
            ? null
            : false
          : expiredBySample - injectedAt <= SAKKAN_NOTED_INTERVAL_TURNS + 1,
    },
  };
}

function buildReport(
  campaignId: string,
  records: TurnRecord[],
  snapshots: SampleSnapshot[],
  verdict: Verdict,
  spend: Awaited<ReturnType<typeof attributeSpend>>,
  resumedFrom: number,
  abort: string | null,
): string {
  const out: string[] = [];
  const pass = verdict.bandHeld && verdict.forced.withinNotedInterval === true && !abort;
  out.push("# M2 Drift Soak Report — the register under temptation");
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(
    `Campaign: \`${campaignId}\` (KEPT — the §0.9 resume substrate)${resumedFrom > 0 ? ` · resumed from turn ${resumedFrom}` : ""}`,
  );
  out.push("");
  out.push(`## VERDICT: ${pass ? "**PASS**" : "**FAIL**"}`);
  out.push("");
  out.push(
    `- Drift band (§4.5, threshold ${DRIFT_THRESHOLD} at conf ≥ ${DRIFT_CONFIDENCE}): ${verdict.bandHeld ? "**HELD** — no axis ends the run out of band under engineered temptation" : `**BROKEN** — ${verdict.uncorrected.length} axis(es) end the run out of band, UNCORRECTED`}`,
  );
  for (const o of verdict.uncorrected) {
    out.push(`  - ${o.axis}: delta ${o.delta} at the final sample (turn ${o.atTurn})`);
  }
  for (const u of verdict.unresolved) {
    out.push(
      `- Unresolved at run end (below the engine's ${DRIFT_CONSECUTIVE}-consecutive trigger — correction never due): ${u.axis} delta ${u.delta} at turn ${u.atTurn} (consecutive ${u.consecutive})`,
    );
  }
  if (verdict.corrected.length > 0) {
    out.push(
      `- Corrected drift (the machinery WORKING — out of band, then pulled back): ${verdict.corrected
        .map((c) => `${c.axis} (out at turn ${c.outAt}, back in by turn ${c.backInAt})`)
        .join("; ")}`,
    );
  }
  if (verdict.escalated.length > 0) {
    out.push(
      `- Player-driven — escalated (§4.5 M2R3: gate tripped, attribution charged the PLAYER, retake closed — NOT a fail; the M2 continuity ambiguity's exit): ${verdict.escalated
        .map((e) => `${e.axis} (delta ${e.delta} at turn ${e.atTurn})`)
        .join("; ")}`,
    );
  }
  const f = verdict.forced;
  out.push(
    `- Forced punch-through arm: ${
      f.injectedAt === null
        ? "not run in this invocation (resumed past the injection turn)"
        : f.withinNotedInterval
          ? `**PASS** — retake on '${FORCED_AXIS}' injected at turn ${f.injectedAt}, expired by the sample at turn ${f.expiredBySample} (≤ ${SAKKAN_NOTED_INTERVAL_TURNS}-turn noted interval + 1 settle)`
          : `**FAIL** — injected at turn ${f.injectedAt}, ${f.expiredBySample === null ? "never expired" : `expired late at turn ${f.expiredBySample}`}`
    }`,
  );
  if (abort) out.push(`- ABORTED: ${abort} (resume with \`pnpm drift-soak -- --resume\`)`);
  out.push("");

  out.push("## Sakkan samples (drift vs the effective premise)");
  out.push("");
  const sampleTurns = new Set<number>();
  for (const snap of snapshots) {
    if (snap.lastSampleTurn === 0 || sampleTurns.has(snap.lastSampleTurn)) continue;
    sampleTurns.add(snap.lastSampleTurn);
    out.push(`### Sample at turn ${snap.lastSampleTurn} (read after turn ${snap.afterTurn})`);
    out.push("");
    out.push("| axis | effective | observed | delta | conf | band |");
    out.push("| --- | ---: | ---: | ---: | ---: | --- |");
    for (const r of snap.readings.filter((x) => x.atTurn === snap.lastSampleTurn)) {
      out.push(
        `| ${r.axis} | ${r.effective} | ${r.observed} | ${r.delta} | ${r.confidence.toFixed(2)} | ${r.inBand ? "in" : "OUT"} |`,
      );
    }
    if (snap.activeNotes.length > 0) {
      out.push("");
      out.push(
        `Active retakes: ${snap.activeNotes.map((n) => `${n.axis} (since turn ${n.sinceTurn})`).join(", ")}`,
      );
    }
    out.push("");
  }

  out.push("## Per-turn table");
  out.push("");
  out.push("| turn | class | tier | narration $ | turn $ | flags |");
  out.push("| ---: | --- | --- | ---: | ---: | --- |");
  for (const r of records) {
    const flags = [...r.failures.map((x) => `FAIL:${x}`), ...r.flags].join("; ") || "—";
    out.push(
      `| ${r.turnNumber} | ${r.label} | ${r.tier} | ${fmtUsd(r.narrationUsd)} | ${fmtUsd(r.turnUsd)} | ${flags} |`,
    );
  }
  out.push("");

  out.push("## Spend attribution");
  out.push("");
  out.push(`- Soak engine spend (all model calls, this campaign): **${fmtUsd(spend.totalUsd)}**`);
  out.push(
    `- Attributed to turns: ${fmtUsd(spend.attributedUsd)} · overhead: ${fmtUsd(spend.overheadUsd)}`,
  );
  out.push("");
  out.push("| narration tier | projected $/turn | projected $/session |");
  out.push("| --- | ---: | ---: |");
  for (const p of spend.projections) {
    out.push(`| ${p.model} | ${fmtUsd(p.perTurnUsd)} | ${fmtUsd(p.perSessionUsd)} |`);
  }
  out.push("");

  out.push("## Beat plan");
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

async function liveRun(db: Db, campaignId: string, resumedFrom: number): Promise<void> {
  const records: TurnRecord[] = [];
  const snapshots: SampleSnapshot[] = [];
  const coldTurns = new Set<number>([1]);
  let injectedAt: number | null = null;
  let abort: string | null = null;

  if (resumedFrom === 0) {
    const opened = await openSession(db, campaignId);
    console.log(`[drift-soak] session opened (pilot=${opened.pilot})`);
  }

  try {
    let intended = resumedFrom + 1;
    while (intended <= TARGET_TURNS) {
      const beat = BEATS[intended];
      if (!beat) throw new Error(`no beat scripted for turn ${intended}`);
      const since = new Date();
      let run: Awaited<ReturnType<typeof runOneTurn>>;
      try {
        run = await runOneTurn(db, campaignId, beat.input);
      } catch (err) {
        if (err instanceof TurnInProgressError) {
          // Crash debris from a killed invocation: a turn row still open or
          // held failed — and its EXECUTOR died with that process, so it
          // will never settle on its own. Go straight to the §5.7 retry
          // route (same dice), then RE-ANCHOR the loop to the durable
          // record; the settled turn already consumed its scripted beat.
          console.warn(`[drift-soak] stale open turn ${err.pendingTurnId} — retry route`);
          await db
            .update(schema.turns)
            .set({ status: "queued" })
            .where(eq(schema.turns.id, err.pendingTurnId));
          void executeTurn(db, err.pendingTurnId).catch((e) =>
            console.error("[drift-soak] stale-turn retry crashed", e),
          );
          const settled = await waitForRowTerminal(db, err.pendingTurnId, 5 * 60_000);
          if (settled !== "complete" && settled !== "channel") {
            abort = `stale turn ${err.pendingTurnId} would not settle (${settled})`;
            break;
          }
          await settleG2IfPending(db, campaignId);
          const [lastRow] = await db
            .select({ turnNumber: schema.turns.turnNumber })
            .from(schema.turns)
            .where(
              and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "complete")),
            )
            .orderBy(desc(schema.turns.turnNumber))
            .limit(1);
          intended = (lastRow?.turnNumber ?? intended - 1) + 1;
          continue;
        }
        throw err;
      }
      if (run.terminal !== "done") {
        const record = await meterTurn(db, campaignId, run, intended, beat.label, since, coldTurns);
        records.push(record);
        abort = `turn ${run.turnNumber} ended ${run.terminal} — stopping with data intact`;
        break;
      }
      await settleG2IfPending(db, campaignId);
      const record = await meterTurn(db, campaignId, run, intended, beat.label, since, coldTurns);
      records.push(record);
      snapshots.push(await snapshotSakkan(db, campaignId, run.turnNumber));
      console.log(
        `[drift-soak] turn ${run.turnNumber} [${beat.class}] ${record.tier} · narration ${fmtUsd(record.narrationUsd)}${record.failures.length ? ` · FAIL(${record.failures.length})` : ""}`,
      );

      if (run.turnNumber === FORCE_AFTER_TURN && injectedAt === null) {
        await injectForcedNote(db, campaignId, run.turnNumber);
        injectedAt = run.turnNumber;
      }
      // Anchor to the durable record, never the loop counter.
      intended = run.turnNumber + 1;
    }
  } catch (err) {
    abort = `unexpected: ${err instanceof Error ? err.message : String(err)}`;
    console.error("[drift-soak] run aborted — writing the report with data so far", err);
  }

  // Session close forces a final Sakkan sample (§4.5 cadence) — the closing
  // read, labeled with the turn actually REACHED (an aborted run must not
  // stamp readings "after turn 24" it never played — first-run labeling bug).
  const lastReached = records.at(-1)?.turnNumber ?? resumedFrom;
  if (!abort && lastReached >= TARGET_TURNS) {
    try {
      await closeSession(db, campaignId, "explicit");
      await settleG2IfPending(db, campaignId);
      snapshots.push(await snapshotSakkan(db, campaignId, lastReached));
    } catch (err) {
      console.warn("[drift-soak] session close failed (final sample lost)", err);
    }
  } else if (abort) {
    // An aborted invocation leaves the sitting OPEN — the resume continues
    // it. Closing here bought a yokoku + memo + sample per crash (run #1).
    console.log("[drift-soak] aborted mid-sitting — session left open for the resume");
  }

  const verdict = computeVerdict(snapshots, injectedAt);
  const spend = await attributeSpend(db, campaignId, records, SESSIONS);
  const report = buildReport(campaignId, records, snapshots, verdict, spend, resumedFrom, abort);
  const reportPath = join(process.cwd(), "docs", "retros", "M2-drift-soak.md");
  writeFileSync(reportPath, report);
  console.log(`\n[drift-soak] report → ${reportPath}`);
  console.log("\n=== DRIFT SOAK SUMMARY ===");
  console.log(`band held: ${verdict.bandHeld} · forced arm: ${JSON.stringify(verdict.forced)}`);
  console.log(`total spend: ${fmtUsd(spend.totalUsd)}`);
}

async function main(): Promise<void> {
  guardNoFable(DEV_TIER_SELECTION);

  if (DRY_RUN) {
    console.log(describePlan());
    if (!process.env.DATABASE_URL) {
      console.warn("[dry-run] DATABASE_URL not set — plan only.");
      return;
    }
    const db = getDb();
    const playerId = `soak_player_${crypto.randomUUID()}`;
    await db.insert(schema.players).values({ id: playerId, email: "drift-dry@example.com" });
    const osp = OpeningStatePackage.parse(BEBOP_OSP);
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: `${TITLE} (dry)`,
        status: "active",
        premiseContract: bebopContract(),
        openingPackage: osp,
        tierModels: DEV_TIER_SELECTION,
      })
      .returning({ id: schema.campaigns.id });
    console.log(`[dry-run] seeded ${c?.id} (contract + OSP parsed OK)`);
    if (c) await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
    await db.delete(schema.players).where(eq(schema.players.id, playerId));
    console.log("[dry-run] teardown OK — ZERO model calls.");
    return;
  }

  const db = getDb();
  const { campaignId, resumedFrom } = await seedOrResume(db);
  console.log(`[drift-soak] LIVE · campaign ${campaignId}`);
  try {
    await liveRun(db, campaignId, resumedFrom);
  } finally {
    await flushLangfuse();
    console.log(`[drift-soak] campaign ${campaignId} KEPT (the §0.9 resume substrate).`);
  }
}

await main();
process.exit(0);
