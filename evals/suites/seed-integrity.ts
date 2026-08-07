import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  DIRECTOR_MAX_INTERVAL,
  SEED_MAX_CANDIDATES,
  SEED_MAX_TURNS_TO_PAYOFF,
  SEED_MIN_TURNS_TO_PAYOFF,
  parseCandidates,
} from "@/lib/types/direction";
import { and, eq } from "drizzle-orm";
import type { Suite, SuiteResult } from "../types";
import { MIN_SOAK_TURNS, resolveSoakCampaign } from "./flywheel-prospective";

/**
 * §10.5 SEED INTEGRITY — the ledger graded against its own promises.
 *
 * The blueprint's letter, whole: "planted seeds pay off inside windows in soak
 * runs; no orphaned dependencies; organic-detection recall spot-checked against
 * declared-only baseline." Those three clauses are the three required probes
 * below, and the thresholds are the clauses themselves — nothing here is tuned
 * to make a particular run green.
 *
 * This suite makes NO model calls and drives NO turns. Everything it grades was
 * decided at play time by the engine's own organs: the Director's plant windows
 * (§7.6), the §7.6 batched adjudicator's payoff/conflict verdicts, the declared
 * path's bounded mention probe (compositor/g2.ts step 6), and the organic
 * sweep's cosine candidates (direction/seeds.ts). The suite reads that record
 * and does arithmetic on it; it re-opens no verdict, so it runs in the
 * deterministic gate.
 *
 *   SEED_CAMPAIGN_ID=<uuid> pnpm evals seed-integrity
 *
 * With no id it falls back to the newest qualifying soak-titled campaign (the
 * same resolver §6.8's prospective suite uses, FLYWHEEL_CAMPAIGN_ID included),
 * and skips LOUDLY when there is none — or when the run it finds is too short
 * to carry the claim. A skip here means NOTHING WAS MEASURED; it is never a
 * pass.
 *
 * WHAT REPLACED THE SCAFFOLD. Until now this name held a `scaffold(...)` stub
 * whose skip text told the reader to "re-run with FLYWHEEL_CAMPAIGN_ID=<uuid>"
 * once a soak existed — implying machinery that was never written (M3 C5's
 * ledger head; the M3-close commit 60c799b recorded it as UNBUILT rather than
 * waving it through). The soak exists now, so the machinery does.
 */

// ---------------------------------------------------------------------------
// Row shapes — what the suite reads. Kept structural (never a strict parse) so
// one malformed jsonb window can't take the whole ledger's evidence down.
// ---------------------------------------------------------------------------

export interface SeedLedgerRow {
  id: string;
  description: string;
  expectedPayoff: string | null;
  status: string;
  plantedTurn: number;
  payoffWindow: unknown;
  resolvedTurn: number | null;
  resolvedBy: string | null;
  mentionCount: number;
  candidates: unknown;
  dependencies: unknown;
  provenance: string;
  /** Tombstoned rows are EXCLUDED from the ledger but kept for dependency
   *  resolution: a dependency pointing at a rewound seed is an orphan, and a
   *  suite that never loaded the row would misreport it as a dangling id. */
  tombstoned: boolean;
}

/** One probe-CONFIRMED declared mention: the ground truth this suite grades
 *  organic detection against (g2 step 6 writes the ids to
 *  `turns.checkpoints.seed_declared` after its bounded probe agrees). */
export interface DeclaredEvent {
  turn: number;
  seedId: string;
}

export interface SeedIntegrityInput {
  campaignId: string;
  /** The deepest turn NUMBER the run reached — the engine's own `currentTurn`
   *  when it last read the ledger, which is what a window is measured against. */
  lastTurn: number;
  /** Completed STORY turns (the §10.3 depth measure). */
  playedTurns: number;
  /** Turns whose G2 marked `seed_sweep` done — the organic path's denominator. */
  sweptTurns: number;
  /**
   * The turn numbers on which a Director cycle ACTUALLY fired in this run
   * (§7.1 cadence, as it happened rather than as it is bounded). This is the
   * spacing that decides how late a settled payoff can be recorded — see
   * {@link deriveCycleTolerance}. Empty when the run predates phase
   * attribution or the meter rows are gone.
   */
  cycleTurns: number[];
  seeds: SeedLedgerRow[];
  declared: DeclaredEvent[];
}

/**
 * Three-way verdicts, the discipline this harness's live siblings already
 * carry (thin-ip-drill, control-key): a probe that could not collect its
 * evidence says UNPROVEN and never reads green. Here "unproven" is always a
 * missing DENOMINATOR — an empty ledger, no settled seed, no declared mention
 * to grade recall against — never a transport error, because this suite makes
 * no calls to fail.
 */
export type SeedVerdictClass = "pass" | "fail" | "unproven";

export interface SeedProbe {
  name: string;
  verdict: SeedVerdictClass;
  detail: string;
}

export interface SeedIntegrityAnalysis {
  probes: SeedProbe[];
  details: string[];
}

/** Every terminal state a seed can be graded in. */
export type SeedFate =
  | "paid_in_window"
  | "paid_early"
  | "paid_late"
  | "open_in_window"
  | "expired_unpaid"
  | "abandoned";

export interface SeedWindow {
  from: number;
  to: number;
}

/**
 * The stored payoff window, defaulted exactly as the engine defaults it —
 * `windowOf` in direction/seeds.ts. Mirrored rather than imported ON PURPOSE:
 * importing that module drags the Voyage client and the meter into a suite the
 * deterministic gate runs with no API keys at all. The two constants ARE
 * imported, so the defaults can never drift apart silently.
 */
export function windowOf(seed: Pick<SeedLedgerRow, "payoffWindow" | "plantedTurn">): SeedWindow {
  const w = seed.payoffWindow as { from?: number; to?: number } | null;
  return {
    from: typeof w?.from === "number" ? w.from : seed.plantedTurn + SEED_MIN_TURNS_TO_PAYOFF,
    to: typeof w?.to === "number" ? w.to : seed.plantedTurn + SEED_MAX_TURNS_TO_PAYOFF,
  };
}

/**
 * One seed's fate against its window at the run's tip.
 *
 * ABANDONED IS NOT A MISS. §7.6 gives the Director `abandon`, and the
 * adjudicator `conflict` — a thread the story contradicted, let go on purpose,
 * is discipline working (§0: stories end intentionally). An OPEN seed the run
 * simply ran past is the miss: nobody paid it, nobody pushed its window out
 * with `adjust_window`, nobody let it go.
 */
export function classifySeed(seed: SeedLedgerRow, lastTurn: number): SeedFate {
  const w = windowOf(seed);
  if (seed.status === "abandoned") return "abandoned";
  if (seed.resolvedTurn !== null) {
    if (seed.resolvedTurn < w.from) return "paid_early";
    if (seed.resolvedTurn > w.to) return "paid_late";
    return "paid_in_window";
  }
  return lastTurn > w.to ? "expired_unpaid" : "open_in_window";
}

/**
 * The settlement-lag tolerance, derived from the run's OWN cadence.
 *
 * A payoff is SETTLED by the §7.6 batched adjudicator, and that batch runs only
 * on Director-cycle turns — so a payoff that lands on the page the turn after
 * its window shuts cannot be RECORDED until the next cycle fires. The maximum
 * structural lateness is therefore the widest gap between consecutive cycle
 * turns, minus one.
 *
 * DIRECTOR_MAX_INTERVAL is deliberately NOT that number. It is the
 * nothing-has-happened BACKSTOP — the cycle fires far sooner in practice, on
 * DIRECTOR_MIN_TURNS_BETWEEN (3) plus event triggers, and the N=50 soak's widest
 * measured gap was 4. Grading against 8 would have granted a 7-turn amnesty this
 * run's cadence never earned, and the suite would have been measuring the
 * constant rather than the ledger. So the tolerance is read off the cycle turns
 * the run actually recorded; the constant survives only as the FALLBACK for a
 * run whose cycle history is missing, and the output says so when it is used.
 */
export function deriveCycleTolerance(cycleTurns: number[]): {
  tolerance: number;
  source: string;
} {
  const turns = [...new Set(cycleTurns.filter((t) => Number.isInteger(t) && t >= 0))].sort(
    (a, b) => a - b,
  );
  if (turns.length < 2) {
    return {
      tolerance: DIRECTOR_MAX_INTERVAL - 1,
      source: `FALLBACK DIRECTOR_MAX_INTERVAL−1: this run recorded ${turns.length} Director-cycle turn(s), too few to measure a gap — the backstop constant stands in for a cadence nobody observed`,
    };
  }
  let maxGap = 0;
  for (let i = 1; i < turns.length; i += 1) {
    const prev = turns[i - 1];
    const next = turns[i];
    if (prev === undefined || next === undefined) continue;
    maxGap = Math.max(maxGap, next - prev);
  }
  return {
    tolerance: Math.max(0, maxGap - 1),
    source: `this run's OWN cadence: ${turns.length} Director-cycle turns (model_calls phase='director_cycle'), widest gap ${maxGap} turn(s), minus 1`,
  };
}

/** Stored dependency ids (jsonb string[]), guarded like every other jsonb read. */
function depsOf(seed: SeedLedgerRow): string[] {
  return Array.isArray(seed.dependencies)
    ? (seed.dependencies as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
}

function short(text: string, n = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// The adjudication, pure.
// ---------------------------------------------------------------------------

export function analyzeSeedIntegrity(input: SeedIntegrityInput): SeedIntegrityAnalysis {
  const details: string[] = [];
  const probes: SeedProbe[] = [];
  const live = input.seeds.filter((s) => !s.tombstoned);
  const byId = new Map(input.seeds.map((s) => [s.id, s]));

  const fates = new Map<SeedFate, SeedLedgerRow[]>();
  for (const seed of live) {
    const fate = classifySeed(seed, input.lastTurn);
    const bucket = fates.get(fate);
    if (bucket) bucket.push(seed);
    else fates.set(fate, [seed]);
  }
  const of = (fate: SeedFate): SeedLedgerRow[] => fates.get(fate) ?? [];
  const histogram = (
    [
      "paid_in_window",
      "paid_early",
      "paid_late",
      "open_in_window",
      "expired_unpaid",
      "abandoned",
    ] as const
  )
    .map((f) => `${f} ${of(f).length}`)
    .join(", ");

  details.push(
    `campaign ${input.campaignId}: ${live.length} live seed(s) over ${input.playedTurns} completed turns (tip turn ${input.lastTurn}); ${input.seeds.length - live.length} tombstoned`,
  );
  details.push(`fates: ${histogram}`);

  // --- Probe 1: payoffs land INSIDE their windows (§10.5 clause 1) ----------
  // WITH CYCLE TOLERANCE (M3R4 R-2), derived from THIS RUN's cadence rather
  // than from the backstop constant — see deriveCycleTolerance. Grading late
  // settlement as rot measures the cadence, not the discipline (the N=50
  // soak's "4 late payoffs" were entirely this artifact); grading it against a
  // constant the run never ran at would measure nothing at all. Lateness
  // BEYOND the derived tolerance is still a miss, and the expired-unpaid probe
  // below — the one that found 13 rotted seeds — is untouched by any of this.
  const { tolerance: CYCLE_TOLERANCE, source: toleranceSource } = deriveCycleTolerance(
    input.cycleTurns,
  );
  const settled = [...of("paid_in_window"), ...of("paid_early"), ...of("paid_late")];
  const early = of("paid_early");
  const late = of("paid_late");
  const overBy = (s: SeedLedgerRow) => (s.resolvedTurn ?? 0) - windowOf(s).to;
  const withinCadence = late.filter((s) => overBy(s) <= CYCLE_TOLERANCE);
  const rotLate = late.filter((s) => overBy(s) > CYCLE_TOLERANCE);
  // Deterministic tie-break on id, the direction/seeds.ts idiom (:83-88): the
  // feeding select carries no ORDER BY of its own guarantee, and two seeds can
  // sit equally far past their windows — the named exemplar must not flip
  // run-to-run, or the same ledger prints two different failure strings.
  const worstLate = rotLate
    .map((s) => ({ s, over: overBy(s) }))
    .sort((a, b) => b.over - a.over || a.s.id.localeCompare(b.s.id))[0];
  const tolerance = `settlement happens only on Director-cycle turns, so lateness ≤ ${CYCLE_TOLERANCE} turn(s) is cadence, not rot — derived from ${toleranceSource}`;
  probes.push({
    name: "payoff-window discipline",
    verdict:
      settled.length === 0 ? "unproven" : early.length + rotLate.length === 0 ? "pass" : "fail",
    detail:
      settled.length === 0
        ? `no seed in this ledger was ever settled — there is no payoff to grade against a window (the ${CYCLE_TOLERANCE}-turn cycle tolerance would have come from ${toleranceSource})`
        : `${settled.length} settled: ${of("paid_in_window").length} inside the window, ${early.length} early, ${withinCadence.length} late within the ${CYCLE_TOLERANCE}-turn cycle tolerance (${tolerance}), ${rotLate.length} late BEYOND it${
            worstLate
              ? ` (worst: "${short(worstLate.s.description)}" window ${windowOf(worstLate.s).from}-${windowOf(worstLate.s).to}, paid turn ${worstLate.s.resolvedTurn} — ${worstLate.over} turn(s) past)`
              : ""
          }`,
  });

  // --- Probe 2: the run does not simply outlive its promises ---------------
  // The blueprint's clause is "planted seeds pay off inside windows". A seed
  // the story ran past without paying it, pushing its window out, or letting it
  // go is that clause failing in its loudest form — and it is the exact state
  // §7.6's overdue→tension bump and `adjust_window` exist to prevent.
  const expired = of("expired_unpaid");
  const overdueBy = (s: SeedLedgerRow) => input.lastTurn - windowOf(s).to;
  // Same tie-break as Probe 1's: the 50-turn soak has two seeds 32 turns
  // overdue, so overdue-magnitude alone leaves the exemplar to row order.
  const worstExpired = [...expired].sort(
    (a, b) => overdueBy(b) - overdueBy(a) || a.id.localeCompare(b.id),
  )[0];
  probes.push({
    name: "no expired-unpaid seeds",
    verdict: live.length === 0 ? "unproven" : expired.length === 0 ? "pass" : "fail",
    detail:
      live.length === 0
        ? "the seed ledger is EMPTY — the Director never planted, so nothing could expire"
        : expired.length === 0
          ? `${of("open_in_window").length} seed(s) open and still inside their windows; ${of("abandoned").length} deliberately abandoned`
          : `${expired.length} of ${live.length} seed(s) sit OPEN past their payoff window at turn ${input.lastTurn} — unpaid, un-pushed (no adjust_window) and un-abandoned${
              worstExpired
                ? `; worst: "${short(worstExpired.description)}" window ${windowOf(worstExpired).from}-${windowOf(worstExpired).to}, ${overdueBy(worstExpired)} turn(s) overdue`
                : ""
            }`,
  });

  // --- Probe 3: no orphaned dependencies (§10.5 clause 2) ------------------
  // A dependency gate opens only when every listed seed reaches "resolved"
  // (callbackReadySeeds). Four ways it can never open: the id names nothing,
  // it names a tombstoned row, it names an ABANDONED seed (which never
  // resolves — the plant-time pool excludes them, but a seed abandoned AFTER
  // being depended on slips through), or the graph loops.
  const orphans: string[] = [];
  let edges = 0;
  for (const seed of live) {
    for (const dep of depsOf(seed)) {
      edges += 1;
      if (dep === seed.id) {
        orphans.push(`"${short(seed.description)}" depends on ITSELF — the gate can never open`);
        continue;
      }
      const target = byId.get(dep);
      if (!target) {
        orphans.push(`"${short(seed.description)}" depends on ${dep.slice(0, 8)} — no such seed`);
      } else if (target.tombstoned) {
        orphans.push(
          `"${short(seed.description)}" depends on a TOMBSTONED seed ("${short(target.description, 40)}")`,
        );
      } else if (target.status === "abandoned") {
        orphans.push(
          `"${short(seed.description)}" depends on an ABANDONED seed ("${short(target.description, 40)}") — abandoned never resolves, so the gate holds forever`,
        );
      }
    }
  }
  for (const cycle of findDependencyCycles(live, byId)) {
    orphans.push(`dependency CYCLE: ${cycle.map((id) => id.slice(0, 8)).join(" → ")}`);
  }
  probes.push({
    name: "no orphaned dependencies",
    verdict: orphans.length === 0 ? "pass" : "fail",
    detail:
      orphans.length === 0
        ? `${edges} dependency edge(s) across ${live.length} seed(s), every one resolvable`
        : orphans.join("; "),
  });
  // Reported beside the gate, never as a failure: a live dependency whose
  // target is itself expired is a gate that WILL hold, without being malformed.
  const blocked = live.filter(
    (s) =>
      classifySeed(s, input.lastTurn) !== "abandoned" &&
      depsOf(s).some((d) => {
        const t = byId.get(d);
        return t !== undefined && !t.tombstoned && t.status !== "resolved";
      }),
  );
  if (blocked.length > 0) {
    details.push(
      `${blocked.length} seed(s) still gated by an unresolved dependency (legal, but the callback channel cannot offer them)`,
    );
  }

  // --- Probe 4: organic-detection recall vs the declared-only baseline -----
  // GROUND TRUTH is the declared path's CONFIRMED mentions: the writer's
  // sidecar claimed the scene would touch a seed, and a bounded probe read the
  // page and agreed (g2 step 6). The organic path is pure cosine over the same
  // scenes, and §10.5 asks whether it can find what the judged path found.
  //
  // TWO STRUCTURAL LIMITS, stated rather than papered over — they are why this
  // is a SEED-LEVEL recall and a "spot-check" rather than an event-level score:
  //   1. The sweep SITS OUT every seed the declared probe just confirmed on
  //      that turn (`alreadyMentioned`, so the two paths never bill one scene
  //      twice). Per-(seed, turn) recall on a declared turn is therefore zero
  //      BY CONSTRUCTION and grading it would measure the exclusion, not the
  //      detector.
  //   2. `seeds.candidates` keeps only the last SEED_MAX_CANDIDATES entries, so
  //      a busy seed's early candidate history is gone. Recall computed from
  //      the stored record can only ever UNDERSTATE the detector.
  const declaredSeeds = new Set(input.declared.map((d) => d.seedId));
  const declaredLive = [...declaredSeeds].filter((id) => byId.get(id)?.tombstoned === false);
  const candidateEvents: { seedId: string; turn: number; adjudicated: boolean }[] = [];
  let truncated = 0;
  for (const seed of live) {
    const cands = parseCandidates(seed.candidates);
    if (cands.length >= SEED_MAX_CANDIDATES) truncated += 1;
    for (const c of cands) {
      candidateEvents.push({ seedId: seed.id, turn: c.t, adjudicated: c.adj === true });
    }
  }
  const organicSeeds = new Set(candidateEvents.map((c) => c.seedId));
  const found = declaredLive.filter((id) => organicSeeds.has(id));
  const recall = declaredLive.length === 0 ? Number.NaN : found.length / declaredLive.length;
  const declaredPairs = new Set(input.declared.map((d) => `${d.seedId}@${d.turn}`));
  const organicOnly = candidateEvents.filter((c) => !declaredPairs.has(`${c.seedId}@${c.turn}`));
  const unmeasurable =
    input.sweptTurns === 0
      ? "the organic sweep never ran on a single turn (no G2 seed_sweep marker) — there is no detector to grade"
      : declaredLive.length === 0
        ? "the declared path confirmed ZERO mentions in this run — §10.5's baseline does not exist, so recall has no denominator"
        : null;
  probes.push({
    name: "organic-detection recall (vs declared-only baseline)",
    // The FLOOR is the blueprint's word, "spot-checked": the code-only detector
    // must not be blind to the threads the judged path confirmed. A tighter
    // numeric floor is deliberately NOT set — §10.5 asks for a spot-check, and
    // a hard rate over a handful of declared mentions would be a tuned number
    // dressed as a measurement. The rate is reported on every run.
    verdict: unmeasurable !== null ? "unproven" : found.length > 0 ? "pass" : "fail",
    detail:
      unmeasurable ??
      `recall ${found.length}/${declaredLive.length} (${(recall * 100).toFixed(0)}%) of declared-confirmed seeds also found by the code-only sweep; the declared-only baseline produced ${input.declared.length} confirmed mention(s) over ${input.sweptTurns} swept turn(s), the organic path ${candidateEvents.length} candidate(s) across ${organicSeeds.size} seed(s) — ${organicOnly.length} on scenes the declared path never named`,
  });

  // --- Reported, never gated ----------------------------------------------
  const adjudicated = candidateEvents.filter((c) => c.adjudicated).length;
  details.push(
    `organic sweep: ${candidateEvents.length} candidate event(s), ${adjudicated} already read by a batched adjudication, ${candidateEvents.length - adjudicated} still pending; ${truncated} seed(s) at the ${SEED_MAX_CANDIDATES}-candidate cap (earlier history discarded — recall is a floor, never a ceiling)`,
  );
  const declaredPerSeed = new Map<string, number>();
  for (const d of input.declared) {
    declaredPerSeed.set(d.seedId, (declaredPerSeed.get(d.seedId) ?? 0) + 1);
  }
  const promoted = live.reduce(
    (sum, s) => sum + Math.max(0, s.mentionCount - (declaredPerSeed.get(s.id) ?? 0)),
    0,
  );
  details.push(
    `mentions: ${live.reduce((n, s) => n + s.mentionCount, 0)} recorded, ${input.declared.length} from the declared probe, ${promoted} promoted from organic candidates by the §7.6 adjudicator`,
  );
  const byResolver = new Map<string, number>();
  for (const s of live) {
    if (s.resolvedTurn === null && s.status !== "abandoned") continue;
    const who = s.resolvedBy ?? "(unrecorded)";
    byResolver.set(who, (byResolver.get(who) ?? 0) + 1);
  }
  if (byResolver.size > 0) {
    details.push(
      `settled by: ${[...byResolver.entries()].map(([who, n]) => `${who}×${n}`).join(", ")}`,
    );
  }
  for (const probe of probes) {
    const mark = probe.verdict === "pass" ? "ok" : probe.verdict === "fail" ? "MISS" : "UNPROVEN";
    details.push(`${mark} ${probe.name}: ${probe.detail}`);
  }
  return { probes, details };
}

/** Every dependency cycle among live seeds (a gate that can never open). */
function findDependencyCycles(live: SeedLedgerRow[], byId: Map<string, SeedLedgerRow>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const walk = (id: string): void => {
    const seed = byId.get(id);
    if (!seed || seed.tombstoned) return;
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      const at = stack.indexOf(id);
      if (at >= 0) cycles.push([...stack.slice(at), id]);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of depsOf(seed)) {
      if (dep !== id) walk(dep);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const seed of live) walk(seed.id);
  return cycles;
}

// ---------------------------------------------------------------------------
// The suite: campaign selection, the loud skips, then the pure adjudication.
// ---------------------------------------------------------------------------

const GATE = "M3 (§10.5 seed integrity / §10.3)";
const HOW_TO_SOAK = `run one first: \`pnpm soak -- --turns=${MIN_SOAK_TURNS}\` or deeper, then re-run with SEED_CAMPAIGN_ID=<campaign uuid>`;

/** The turn-row read: the tip, the depth, the sweep denominator, the ground truth. */
interface TurnRead {
  lastTurn: number;
  playedTurns: number;
  sweptTurns: number;
  declared: DeclaredEvent[];
}

function readTurns(rows: { turnNumber: number; status: string; checkpoints: unknown }[]): TurnRead {
  let lastTurn = 0;
  let playedTurns = 0;
  let sweptTurns = 0;
  const declared: DeclaredEvent[] = [];
  for (const row of rows) {
    // A channel beat consumes a turn NUMBER without telling a story, and a
    // payoff window is measured in turn numbers — so the tip counts every row
    // while the depth counts only completed story turns.
    lastTurn = Math.max(lastTurn, row.turnNumber);
    if (row.status === "complete") playedTurns += 1;
    const cp = (row.checkpoints ?? {}) as Record<string, unknown>;
    const g2 = (cp.g2 ?? {}) as Record<string, unknown>;
    if (g2.seed_sweep === true) sweptTurns += 1;
    if (Array.isArray(cp.seed_declared)) {
      for (const id of cp.seed_declared) {
        if (typeof id === "string") declared.push({ turn: row.turnNumber, seedId: id });
      }
    }
  }
  return { lastTurn, playedTurns, sweptTurns, declared };
}

async function loadInput(campaignId: string): Promise<SeedIntegrityInput> {
  const db = getDb();
  const turnRows = await db
    .select({
      turnNumber: schema.turns.turnNumber,
      status: schema.turns.status,
      checkpoints: schema.turns.checkpoints,
    })
    .from(schema.turns)
    .where(eq(schema.turns.campaignId, campaignId))
    .orderBy(schema.turns.turnNumber);

  // TOMBSTONED ROWS ARE READ HERE, unlike every play-path query: a dependency
  // pointing at a rewound seed is an orphan, and the only way to say so rather
  // than report a dangling uuid is to have the row in hand. `tombstoned` below
  // keeps them out of the ledger's own grades.
  const seedRows = await db
    .select({
      id: schema.seeds.id,
      description: schema.seeds.description,
      expectedPayoff: schema.seeds.expectedPayoff,
      status: schema.seeds.status,
      plantedTurn: schema.seeds.plantedTurn,
      payoffWindow: schema.seeds.payoffWindow,
      resolvedTurn: schema.seeds.resolvedTurn,
      resolvedBy: schema.seeds.resolvedBy,
      mentionCount: schema.seeds.mentionCount,
      candidates: schema.seeds.candidates,
      dependencies: schema.seeds.dependencies,
      provenance: schema.seeds.provenance,
      tombstonedAt: schema.seeds.tombstonedAt,
    })
    .from(schema.seeds)
    .where(eq(schema.seeds.campaignId, campaignId))
    // Stable row order into every probe: Postgres owes none without it, and the
    // ledger's exemplars and detail strings are read as a fixed record.
    .orderBy(schema.seeds.id);

  // The run's OWN Director cadence (M3R4 R-2 audit). The meter is the only row
  // source that records WHEN a cycle fired — direction_state keeps just the
  // last one, and turns.checkpoints marks the trigger, not the firing. Every
  // cycle-scoped call (the startup plan, the two emit halves, the investigation
  // rounds, the batched adjudication) files under phase='director_cycle' at the
  // cycle's own turn number, so DISTINCT turn number is the cycle history.
  const cycleRows = await db
    .selectDistinct({ turnNumber: schema.modelCalls.turnNumber })
    .from(schema.modelCalls)
    .where(
      and(
        eq(schema.modelCalls.campaignId, campaignId),
        eq(schema.modelCalls.phase, "director_cycle"),
      ),
    );

  const { lastTurn, playedTurns, sweptTurns, declared } = readTurns(turnRows);
  return {
    campaignId,
    lastTurn,
    playedTurns,
    sweptTurns,
    cycleTurns: cycleRows
      .map((r) => r.turnNumber)
      .filter((t): t is number => typeof t === "number"),
    declared,
    seeds: seedRows.map(({ tombstonedAt, ...row }) => ({
      ...row,
      tombstoned: tombstonedAt !== null,
    })),
  };
}

export const seedIntegrity: Suite = {
  name: "seed-integrity",
  gate: GATE,
  // No model call anywhere: the soak already paid for every judgment this reads.
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const skip = (reason: string): SuiteResult => ({
      name: "seed-integrity",
      gate: GATE,
      status: "skipped",
      details: [reason],
      failures: [],
    });

    if (!process.env.DATABASE_URL) {
      return skip(
        `NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns and DATABASE_URL is unset — nothing was measured; ${HOW_TO_SOAK}`,
      );
    }

    let input: SeedIntegrityInput;
    let how: string;
    try {
      const target = await resolveSoakCampaign(["SEED_CAMPAIGN_ID", "FLYWHEEL_CAMPAIGN_ID"]);
      if (!target) {
        // Two different silences, and the message must not conflate them: under
        // --ci the resolver returns before the discovery query ever runs, so
        // nothing was searched, let alone rejected.
        return skip(
          process.argv.includes("--ci")
            ? `NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns and none was NAMED (no SEED_CAMPAIGN_ID / FLYWHEEL_CAMPAIGN_ID). Under --ci discovery is not attempted at all — no campaign was looked for, so this is not evidence that none exists. Name one, or run without --ci against a soaked dev DB; ${HOW_TO_SOAK}`
            : `NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns; none found (no SEED_CAMPAIGN_ID / FLYWHEEL_CAMPAIGN_ID, and discovery matched no soak-titled campaign) — ${HOW_TO_SOAK}`,
        );
      }
      how = target.how;
      input = await loadInput(target.id);
    } catch (err) {
      return skip(
        `could not read the soaked campaign — nothing measured: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (input.playedTurns < MIN_SOAK_TURNS) {
      return skip(
        `campaign ${input.campaignId} (${how}) has ${input.playedTurns} completed turns; this suite needs ≥ ${MIN_SOAK_TURNS}. §7.6's own numbers say why: a plant's default window opens ${SEED_MIN_TURNS_TO_PAYOFF} turns out and runs ${SEED_MAX_TURNS_TO_PAYOFF}, so a shorter run cannot show a window being kept OR missed. ${HOW_TO_SOAK}`,
      );
    }

    const { probes, details } = analyzeSeedIntegrity(input);
    const failures = probes
      .filter((p) => p.verdict !== "pass")
      .map((p) =>
        p.verdict === "unproven"
          ? `${p.name}: UNPROVEN (evidence not collected) — ${p.detail}`
          : `${p.name}: ${p.detail}`,
      );
    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details: [`campaign source: ${how}`, ...details],
      failures,
    };
  },
};
