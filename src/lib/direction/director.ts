import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, criticalFacts, entities, pencilMarks, sessionRecords } from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { gaugeTrend } from "@/lib/sakkan/sakkan";
import {
  GET_TURN_NARRATIVE_TOOL,
  RECALL_SCENE_TOOL,
  SEARCH_LORE_TOOL,
  executeGetTurnNarrative,
  executeRecallScene,
  executeSearchLore,
} from "@/lib/turn/tools";
import type { ArcOverride } from "@/lib/types/arc";
import { PartialComposition } from "@/lib/types/composition";
import {
  DIRECTOR_EPICNESS_THRESHOLD,
  DIRECTOR_MAX_INTERVAL,
  DIRECTOR_MAX_TOOL_ROUNDS,
  DIRECTOR_MIN_TURNS_BETWEEN,
  DirectionState,
  DirectorArcPlan,
  DirectorOutput,
  type DirectorTrigger,
} from "@/lib/types/direction";
import { PartialDNAScales } from "@/lib/types/dna";
import { OpeningStatePackage } from "@/lib/types/opening";
import { PremiseContract } from "@/lib/types/premise";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  applyArcPlan,
  arcPosition,
  budgetPriorFor,
  closeEpisode,
  ensureSeriesScaffold,
  expectedTension,
  getActiveArc,
  payoffDebt,
  seriesBudget,
} from "./arcs";
import { overdueSeeds, overdueTensionBump, plantSeed, seedDossier, settleSeed } from "./seeds";

/**
 * The Director (blueprint §7.1): the story wants something. Runs in
 * Chronicler G2 on the hybrid trigger; investigates with a budgeted tool
 * loop (≤ DIRECTOR_MAX_TOOL_ROUNDS rounds over seeds, spotlight, entities,
 * semantic search, recall_scene, canon); reviews the dailies (Gauge trend
 * STUB until C8; Framing adherence qualitative; Critical-layer size →
 * demotions); emits ONE typed DirectorOutput the engine applies.
 *
 * Judgment tier, never narration: the Director is bookkeeping judgment —
 * its prose never reaches the player (axiom 2); its notes reach the KA via
 * the Scene-Shape Directive.
 */

const DIRECTOR_PROVENANCE = "director";

export function initialDirectionState(): DirectionState {
  return DirectionState.parse({});
}

/** Load campaigns.direction_state, defaulting a valid empty state. */
export async function loadDirectionState(db: Db, campaignId: string): Promise<DirectionState> {
  const [row] = await db
    .select({ directionState: campaigns.directionState })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  return DirectionState.parse(row?.directionState ?? {});
}

export async function saveDirectionState(
  db: Db,
  campaignId: string,
  state: DirectionState,
): Promise<void> {
  await db
    .update(campaigns)
    .set({ directionState: state, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
}

/**
 * v3's hybrid trigger, verbatim (_background.py): turnNumber > 0 AND
 * turns_since ≥ DIRECTOR_MIN_TURNS_BETWEEN AND (accumulated_epicness ≥
 * DIRECTOR_EPICNESS_THRESHOLD OR arc_events nonempty OR turns_since ≥
 * DIRECTOR_MAX_INTERVAL). Pure math, unit-tested.
 */
export function evaluateDirectorTrigger(
  state: DirectionState,
  turnNumber: number,
): DirectorTrigger {
  const turnsSince = turnNumber - state.last_director_turn;
  const gate = turnNumber > 0 && turnsSince >= DIRECTOR_MIN_TURNS_BETWEEN;
  const reasons: string[] = [];
  if (gate) {
    if (state.accumulated_epicness >= DIRECTOR_EPICNESS_THRESHOLD) {
      reasons.push(`epicness:${state.accumulated_epicness.toFixed(1)}`);
    }
    if (state.arc_events.length > 0) reasons.push(`events:${state.arc_events.length}`);
    if (turnsSince >= DIRECTOR_MAX_INTERVAL) reasons.push("max_interval");
  }
  return { fire: gate && reasons.length > 0, reasons };
}

/** Fold one landed turn into the accumulators (epicness, arc events). Pure. */
export function accumulate(
  state: DirectionState,
  turn: { epicness: number; events: string[] },
): DirectionState {
  return {
    ...state,
    accumulated_epicness: state.accumulated_epicness + turn.epicness,
    arc_events: [...state.arc_events, ...turn.events],
  };
}

/** campaigns.tier_models → TierSelection, falling back to the infra default. */
function resolveSelection(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

// --- Investigation toolkit (§7.1) -------------------------------------------

const GET_SEED_LEDGER_TOOL: Tool = {
  name: "get_seed_ledger",
  description:
    "The full seed ledger — every active/overdue/callback-ready seed with its payoff window, urgency, dependencies and status. Use to decide what to plant, resolve, or let go stale.",
  input_schema: { type: "object", properties: {}, required: [] },
};

const GET_ARC_STATE_TOOL: Tool = {
  name: "get_arc_state",
  description:
    "The active arc's objective state: shape, phase, position (budget consumed vs target), expected-vs-tracked tension, and payoff debt. Use to judge stall (deviation + overstay) and rush (climax approaching with open payoff debt).",
  input_schema: { type: "object", properties: {}, required: [] },
};

const DIRECTOR_TOOLS: Tool[] = [
  SEARCH_LORE_TOOL,
  RECALL_SCENE_TOOL,
  GET_TURN_NARRATIVE_TOOL,
  GET_SEED_LEDGER_TOOL,
  GET_ARC_STATE_TOOL,
];

/** get_arc_state executor: the objective arc snapshot, formatted for the pen. */
async function formatArcState(db: Db, campaignId: string, turnNumber: number): Promise<string> {
  const arc = await getActiveArc(db, campaignId);
  if (!arc) return "No active arc yet.";
  const position = await arcPosition(db, campaignId, arc, turnNumber);
  const debt = payoffDebt(arc, { consumed: position.consumed, target: position.target });
  const expected = expectedTension(arc.shape, position.fraction);
  return [
    `Arc "${arc.name}" (${arc.shape}, phase ${arc.phase}, status ${arc.status})`,
    `Dramatic question: ${arc.dramaticQuestion}`,
    `Position: ${position.consumed}/${position.target} (${Math.round(position.fraction * 100)}% consumed)`,
    `Expected tension at position: ${expected.toFixed(2)}`,
    `Payoff debt: ${debt.openItems} open item(s), ${debt.remaining} budget remaining${debt.rushed ? " — RUSHED" : ""}`,
  ].join("\n");
}

// --- Persona (§7.1 + §7.5) ---------------------------------------------------

const DIRECTOR_CHISEL =
  'Above the Outcome Judge\'s door, chiseled: "Failure must never be the engine defending its plot — and stories only end intentionally, never at the behest of a die-roll." Player-earned wins you did not plan are real; you replan around them. Even a total defeat is a narrative pivot, not a termination.';

/**
 * Finitude's behavioral consumer (§8 — "finite = the Director quietly builds
 * toward a planned finale across seasons"; restored M2R R2 after the audit
 * found finite and indefinite campaigns receiving identical direction).
 */
export function finitudeDirective(finitude: PremiseContract["finitude"]): string {
  switch (finitude) {
    case "finite":
      return "FINITE — this story ENDS. Build quietly toward a planned finale across seasons: arc plans converge, seeds amortize toward payoff, nothing sprawls that cannot close. The finale is planned, never announced.";
    case "indefinite":
      return "INDEFINITE — an open cycle. Never force or drift toward an ending; arcs resolve and renew. Sprawl is licensed; closure debt is not a pressure here.";
    case "undecided":
      return "UNDECIDED — revisited at season boundaries, never resolved unilaterally. As a season boundary nears, add a director note that the finitude question is due back to the player.";
  }
}

function directorPersona(contract: PremiseContract): string {
  const ipVoice = contract.active.voice.director_personality;
  return [
    ipVoice,
    "",
    "You are the Director — this campaign's showrunner (§7.1). Story-first and measured: you plan arcs, track seeds and spotlight, and read whether the story still IS what it framed itself as. You never write prose; your notes are advisory craft direction for the writer, riding the Scene-Shape Directive to the Key Animator — guidance, never lines to speak.",
    "",
    DIRECTOR_CHISEL,
    "",
    "Dailies duties: judge Framing adherence qualitatively (the enums carry no numeric gauge — read the drift, don't measure it). Review the Critical layer's size with demotion restraint — demote only stale facts whose loss no longer breaks continuity (§6.3); criticality is earned and revocable, never a ratchet, and you demote, never delete.",
    "",
    "You are never an anxious check-in. An author who keeps asking permission has no voice. Decide, in the fiction's own language.",
  ].join("\n");
}

// --- Dossier compilation (§7.1 investigation seed) ---------------------------

function framingLine(contract: PremiseContract): string {
  const f = contract.active.framing;
  const t = contract.active.treatment;
  return [
    `arc_shape=${f.arc_shape}`,
    `escalation=${f.escalation_pattern}`,
    `story_time=${f.story_time_density}`,
    `tension_source=${f.tension_source}`,
    `resolution=${f.resolution_trajectory}`,
    `pacing=${t.pacing}/9`,
    `continuity=${t.continuity}/9`,
  ].join(", ");
}

/**
 * The full Director cycle: investigation loop → dailies → typed output →
 * APPLY (arc plan via arcs.applyArcPlan; arc_override latest-wins onto
 * campaigns.arcOverride with started_turn stamped; seed ops via seeds.ts;
 * demotions set criticalFacts.demotedAt; scene-shape base + arc_relevance +
 * notes + voice patterns + tension into DirectionState; accumulators and
 * pending_flags reset; last_director_turn = turnNumber). Returns the output
 * for tracing/tests. Idempotence: G2's step marker guards re-entry — this
 * function itself may assume one invocation per landed trigger.
 */
export async function runDirectorCycle(
  db: Db,
  campaignId: string,
  turnNumber: number,
  opts?: { trigger?: string },
): Promise<DirectorOutput> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`runDirectorCycle: campaign ${campaignId} not found`);
  const contract = PremiseContract.parse(campaign.premiseContract);
  const selection = resolveSelection(campaign.tierModels);
  const state = DirectionState.parse(campaign.directionState ?? {});
  const profileIds = contract.anchors_used;

  // --- Compile the dossier in code (§7.1) -----------------------------------
  const arc = await getActiveArc(db, campaignId);
  const arcSection: string[] = [];
  if (arc) {
    const position = await arcPosition(db, campaignId, arc, turnNumber);
    const debt = payoffDebt(arc, { consumed: position.consumed, target: position.target });
    const expected = expectedTension(arc.shape, position.fraction);
    const deviation = state.tension_level - expected;
    arcSection.push(
      `Active arc "${arc.name}" (${arc.shape}, phase ${arc.phase}).`,
      `Position ${position.consumed}/${position.target} (${Math.round(position.fraction * 100)}% consumed).`,
      `Trajectory: tracked tension ${state.tension_level.toFixed(2)} vs expected ${expected.toFixed(2)} (deviation ${deviation >= 0 ? "+" : ""}${deviation.toFixed(2)}).`,
      `Payoff debt: ${debt.openItems} open item(s) vs ${debt.remaining} remaining${debt.rushed ? " — RUSH SIGNAL" : ""}.`,
    );
  } else {
    arcSection.push("No active arc yet — plan the opening movement.");
  }

  const seedText = await seedDossier(db, campaignId, turnNumber);
  const overdue = await overdueSeeds(db, campaignId, turnNumber);
  const overdueBump = overdueTensionBump(overdue.length);
  const overdueNote =
    overdue.length > 0
      ? `${overdue.length} seed(s) overdue → tension pressure +${overdueBump.toFixed(2)} (cap 1.0). Resolve, escalate, or consciously abandon.`
      : "No overdue seeds.";

  const spotlightRows = await db
    .select({ name: entities.name, state: entities.state })
    .from(entities)
    .where(
      and(
        eq(entities.campaignId, campaignId),
        inArray(entities.entityType, ["npc", "faction"]),
        eq(entities.status, "active"),
        notTombstoned(entities),
      ),
    );
  const spotlightDebts = spotlightRows
    .map((e) => ({
      name: e.name,
      debt: Number((e.state as { spotlightDebt?: number } | null)?.spotlightDebt ?? 0),
    }))
    .filter((x) => x.debt >= 2)
    .sort((a, b) => b.debt - a.debt);
  const spotlightNote =
    spotlightDebts.length > 0
      ? spotlightDebts.map((x) => `- ${x.name} (debt ${x.debt})`).join("\n")
      : "No spotlight debts ≥ 2.";

  const [critRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(criticalFacts)
    .where(
      and(
        eq(criticalFacts.campaignId, campaignId),
        isNull(criticalFacts.demotedAt),
        notTombstoned(criticalFacts),
      ),
    );
  const criticalCount = critRow?.n ?? 0;

  // The series row's budget gets its reader here (M2R R2 audit — a stored
  // horizon nothing reads is a defect): descriptive judgment context only;
  // never rushed-math (see seriesBudgetFor's warning).
  const horizon = await seriesBudget(db, campaignId);

  // The last session's carry-forward memo — Learned reader #2 (§7.1). Without
  // this read, the 400-word memo written at every close was a writer with no
  // reader in ongoing play (C7 audit, axiom 8): the startup path reads memos
  // but only ever runs on the pilot.
  const [lastClosed] = await db
    .select({ memo: sessionRecords.directorMemo, n: sessionRecords.sessionNumber })
    .from(sessionRecords)
    .where(
      and(
        eq(sessionRecords.campaignId, campaignId),
        sql`${sessionRecords.closedAt} IS NOT NULL`,
        notTombstoned(sessionRecords),
      ),
    )
    .orderBy(desc(sessionRecords.sessionNumber))
    .limit(1);
  const memoSection = lastClosed?.memo
    ? [`## Your memo from session ${lastClosed.n} (carry forward)`, lastClosed.memo, ""]
    : [];
  // Dailies consumer #2 (C8): the Sakkan's measured drift read. The static
  // circular import (director ⇄ sakkan) is function-scope only on both sides
  // — bindings resolve at call time, never at module init.
  const trend = gaugeTrend(state);

  const dossier = [
    `# Director cycle — turn ${turnNumber}${opts?.trigger ? ` (${opts.trigger})` : ""}`,
    "",
    "## The spark (the campaign's central question — read it first)",
    contract.spark,
    "",
    "## Series contract (finitude — the player's word; only they may change it)",
    finitudeDirective(contract.finitude),
    ...(horizon
      ? [`Series horizon: ~${horizon.target} ${horizon.unit}, ± ${horizon.tolerance}.`]
      : []),
    "",
    "## Framing (what this story frames itself as)",
    framingLine(contract),
    "",
    "## Arc",
    arcSection.join("\n"),
    "",
    "## Seeds",
    seedText,
    overdueNote,
    "",
    "## Spotlight debts (npc/faction absent ≥ 2 scenes)",
    spotlightNote,
    "",
    ...(trend ? ["## Gauge trend (Sakkan, §4.5 — the dailies' drift read)", trend, ""] : []),
    "## Critical layer (§6.3 dailies review)",
    `${criticalCount} active critical fact(s). Demote only what has gone stale — restraint, not a purge.`,
    "",
    ...memoSection,
    "## Pending flags routed to you",
    state.pending_flags.length > 0 ? state.pending_flags.map((f) => `- ${f}`).join("\n") : "None.",
    "",
    "## Your prior notes",
    state.director_notes.length > 0
      ? state.director_notes.map((n) => `- ${n}`).join("\n")
      : "None yet.",
    "",
    "## Your task",
    `Investigate with your tools (up to ${DIRECTOR_MAX_TOOL_ROUNDS} rounds — seeds, arc, canon, past scenes), then emit ONE typed plan: the arc plan (name/phase/shape/budget/payoff), tension level, any single arc_override (latest wins, with its transition signal; express premise shifts as axis/value pairs) OR clear_override, seeds to plant/resolve/abandon, criticals to demote, the Scene-Shape base, an arc_relevance ranking of secondary axes, director notes (advisory), and voice patterns.`,
  ].join("\n");

  // --- One creative judgment call with the investigation loop ---------------
  const executeTool = async (name: string, input: unknown): Promise<string> => {
    switch (name) {
      case "search_lore":
        return executeSearchLore(db, profileIds, input as { query: string; page_type?: string }, {
          campaignId,
          turnNumber,
        });
      case "recall_scene":
        return executeRecallScene(db, campaignId, input as { turn_number: number });
      case "get_turn_narrative":
        return executeGetTurnNarrative(
          db,
          campaignId,
          input as { from_turn: number; to_turn: number },
        );
      case "get_seed_ledger":
        return seedDossier(db, campaignId, turnNumber);
      case "get_arc_state":
        return formatArcState(db, campaignId, turnNumber);
      default:
        return `unknown tool ${name}`;
    }
  };

  const output = await callJudgment(selection, {
    name: `director_${opts?.trigger ?? "cycle"}`,
    schema: DirectorOutput,
    campaignId,
    turnNumber,
    // 16k, not 8k: adaptive thinking spends from this budget (three prior
    // sightings of an 8k ceiling truncating a live judgment mid-emit).
    maxTokens: 16_000,
    effort: "high",
    system: directorPersona(contract),
    prompt: dossier,
    tools: DIRECTOR_TOOLS,
    executeTool,
    maxToolRounds: DIRECTOR_MAX_TOOL_ROUNDS,
  });

  // --- APPLY (§7.1) ---------------------------------------------------------
  const { arcId, phaseChanged } = await applyArcPlan(db, campaignId, turnNumber, output.arc_plan);

  if (output.episode_close) {
    await closeEpisode(db, campaignId, turnNumber, output.episode_close, arcId);
  }

  // arc_override latest-wins onto the campaign; a new one supersedes any clear.
  // The model speaks in axis/value PAIRS (the strict-output grammar caps
  // optional params — C7 live probe); the stored ArcOverride carries the
  // partial records, so convert here. An invalid shift set drops with a warn
  // rather than costing the whole override.
  if (output.arc_override) {
    const dnaRecord: Record<string, number> = {};
    for (const s of output.arc_override.dna_shifts) dnaRecord[s.axis] = s.value;
    const compRecord: Record<string, string> = {};
    for (const s of output.arc_override.composition_shifts) compRecord[s.axis] = s.value;
    const dna = PartialDNAScales.safeParse(dnaRecord);
    const composition = PartialComposition.safeParse(compRecord);
    if (!dna.success && output.arc_override.dna_shifts.length > 0) {
      console.warn(`[director] dropped invalid dna_shifts: ${dna.error.message}`);
    }
    if (!composition.success && output.arc_override.composition_shifts.length > 0) {
      console.warn(`[director] dropped invalid composition_shifts: ${composition.error.message}`);
    }
    const override: ArcOverride = {
      arc_name: output.arc_override.arc_name,
      started_turn: turnNumber,
      transition_signal: output.arc_override.transition_signal,
      ...(dna.success && Object.keys(dna.data).length > 0 ? { dna: dna.data } : {}),
      ...(composition.success && Object.keys(composition.data).length > 0
        ? { composition: composition.data }
        : {}),
    };
    await db.update(campaigns).set({ arcOverride: override }).where(eq(campaigns.id, campaignId));
  } else if (output.clear_override) {
    await db.update(campaigns).set({ arcOverride: null }).where(eq(campaigns.id, campaignId));
  }

  for (const op of output.seed_ops) {
    if (op.op === "plant") {
      await plantSeed(db, campaignId, turnNumber, op, DIRECTOR_PROVENANCE);
    } else {
      await settleSeed(db, campaignId, turnNumber, op);
    }
  }

  // §6.3: demotion, not erasure — set demotedAt, never delete.
  for (const match of output.demote_criticals) {
    if (!match.trim()) continue;
    // Literal containment, not pattern matching: %/_ in the model's string
    // ("50% morale") are live ILIKE wildcards unless escaped — unescaped they
    // over-demote facts the Director never named (C7 audit).
    const literal = match.replace(/([\\%_])/g, "\\$1");
    await db
      .update(criticalFacts)
      .set({ demotedAt: new Date() })
      .where(
        and(
          eq(criticalFacts.campaignId, campaignId),
          isNull(criticalFacts.demotedAt),
          notTombstoned(criticalFacts),
          sql`${criticalFacts.content} ILIKE ${`%${literal}%`}`,
        ),
      );
  }

  const relevanceRecord: Record<string, number> = {};
  for (const r of output.arc_relevance) relevanceRecord[r.axis] = r.relevance;

  const newState: DirectionState = {
    ...state,
    tension_level: output.tension_level,
    scene_shape: {
      trajectory_note: output.scene_shape_trajectory,
      notes: output.scene_shape_notes,
    },
    arc_relevance: output.arc_relevance.length > 0 ? relevanceRecord : state.arc_relevance,
    director_notes: output.director_notes,
    voice_patterns: output.voice_patterns,
    // §7.1 spotlight output lands in state so Layout can surface it as conte
    // spotlight_hints — a Director writer with no reader is a defect (axiom 8).
    spotlight_directives: output.spotlight_directives,
    // Accumulators reset; the trigger begins re-arming from here.
    accumulated_epicness: 0,
    arc_events: [],
    pending_flags: [],
    last_director_turn: turnNumber,
    // phase_state stamps from arc_plan.phase — the SAME field applyArcPlan
    // persisted and derived phaseChanged from. Stamping the (now removed)
    // separate top-level phase field let the Pacer's stall gates run against
    // a different phase than the arc row's (C7 audit, two lenses).
    ...(phaseChanged
      ? {
          phase_state: {
            arc_id: arcId,
            phase: output.arc_plan.phase,
            entered_at_turn: turnNumber,
          },
        }
      : {}),
  };
  await saveDirectionState(db, campaignId, newState);

  return output;
}

// --- Startup (§7.1 session boundaries, first open) ---------------------------

const StartupPlan = z.object({
  arc: DirectorArcPlan,
  cold_open_constraints: z.array(z.string()).max(5).default([]),
  scene_shape_notes: z.array(z.string()).max(3).default([]),
});

/**
 * Campaign-open startup (§7.1 session boundaries, first open only): reads
 * the Opening State Package AND the Learned layer (prior memos + marks —
 * Learned reader #2), ensures the Series/Season/first-Arc scaffold
 * (arcs.ensureSeriesScaffold + applyArcPlan with budgetPriorFor priors,
 * dramatic_question descending from the spark), and writes the PilotPlan
 * (cold-open constraints + OSP forbidden_opening_moves + opening_pov) into
 * DirectionState for Layout to inject into turn 1's conte.
 */
export async function directorStartup(db: Db, campaignId: string): Promise<void> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`directorStartup: campaign ${campaignId} not found`);
  const contract = PremiseContract.parse(campaign.premiseContract);
  const osp = OpeningStatePackage.parse(campaign.openingPackage);
  const selection = resolveSelection(campaign.tierModels);
  const state = DirectionState.parse(campaign.directionState ?? {});

  await ensureSeriesScaffold(db, campaignId, contract);

  // Learned layer (reader #2): latest memos + active marks.
  const memos = await db
    .select({
      sessionNumber: sessionRecords.sessionNumber,
      directorMemo: sessionRecords.directorMemo,
      voiceJournal: sessionRecords.voiceJournal,
    })
    .from(sessionRecords)
    .where(and(eq(sessionRecords.campaignId, campaignId), notTombstoned(sessionRecords)))
    .orderBy(desc(sessionRecords.sessionNumber))
    .limit(2);
  const marks = await db
    .select({
      kind: pencilMarks.kind,
      topic: pencilMarks.topic,
      direction: pencilMarks.direction,
    })
    .from(pencilMarks)
    .where(
      and(
        eq(pencilMarks.campaignId, campaignId),
        isNull(pencilMarks.supersededBy),
        notTombstoned(pencilMarks),
      ),
    )
    .orderBy(desc(pencilMarks.turnId))
    .limit(10);

  const budgetPrior = budgetPriorFor(contract);

  const learnedSection =
    memos.length > 0 || marks.length > 0
      ? [
          "",
          "## Learned layer (prior sessions — this is a re-open of a played campaign)",
          ...memos.map(
            (m) =>
              `Session ${m.sessionNumber} memo: ${m.directorMemo ?? "(none)"}${m.voiceJournal ? `\nVoice: ${m.voiceJournal}` : ""}`,
          ),
          ...marks.map((m) => `- mark [${m.kind}/${m.topic}]: ${m.direction}`),
        ]
      : ["", "## Learned layer", "First open — no prior sessions."];

  const dossier = [
    "# Pilot planning — Director startup briefing",
    "",
    "## The spark (the campaign's central question — the dramatic_question descends from this)",
    contract.spark,
    "",
    "## Series contract (finitude — the player's word; only they may change it)",
    finitudeDirective(contract.finitude),
    "",
    "## Framing",
    framingLine(contract),
    "",
    "## Opening situation (from Session Zero)",
    osp.director_inputs.opening_situation,
    "",
    "## Spark reading (directable pressure)",
    osp.director_inputs.spark_reading,
    "",
    "## Suggested first-arc question",
    osp.director_inputs.suggested_first_arc_question,
    "",
    "## Budget prior (genre default — stay within tolerance of this budget unless the story demands otherwise)",
    `unit=${budgetPrior.unit}, target=${budgetPrior.target}, tolerance=${budgetPrior.tolerance}`,
    ...learnedSection,
    "",
    "## Your task",
    "Plan the OPENING ARC. Name it (IP-appropriate, evocative), set phase to Setup, give it a dramatic_question descending from the spark, its shape and a budget within tolerance of the prior. Then: ≤5 cold_open_constraints and ≤3 scene_shape_notes for the writer's first scene. Do NOT restate the forbidden opening moves — those pass through as hard constraints, verbatim.",
  ].join("\n");

  const plan = await callJudgment(selection, {
    name: "director_startup",
    schema: StartupPlan,
    campaignId,
    turnNumber: 0,
    maxTokens: 16_000,
    effort: "high",
    system: directorPersona(contract),
    prompt: dossier,
  });

  const { arcId } = await applyArcPlan(db, campaignId, 0, plan.arc);

  const newState: DirectionState = {
    ...state,
    tension_level: 0.2,
    phase_state: { arc_id: arcId, phase: plan.arc.phase, entered_at_turn: 0 },
    scene_shape: { notes: plan.scene_shape_notes },
    pilot_plan: {
      cold_open_constraints: plan.cold_open_constraints,
      // Hard constraints — passed through verbatim, never model-rewritten (§8).
      forbidden_opening_moves: osp.animation_inputs.forbidden_opening_moves,
      opening_pov: osp.animation_inputs.opening_pov,
      first_arc_question: plan.arc.dramatic_question,
      consumed: false,
    },
    last_director_turn: 0,
  };
  await saveDirectionState(db, campaignId, newState);
}

/**
 * Session-open review (subsequent opens): a Director cycle with trigger
 * "session_open" — reads the last session memo, refreshes the plan.
 */
export async function directorReview(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<void> {
  await runDirectorCycle(db, campaignId, turnNumber, { trigger: "session_open" });
}
