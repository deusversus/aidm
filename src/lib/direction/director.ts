import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  criticalFacts,
  entities,
  pencilMarks,
  semanticMemories,
  sessionRecords,
} from "@/lib/db/schema";
import { LOOPED_LARGE } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { gaugeTrend, playerDrivenTrend } from "@/lib/sakkan/sakkan";
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
  DIRECTOR_CAPS,
  DIRECTOR_EPICNESS_THRESHOLD,
  DIRECTOR_MAX_INTERVAL,
  DIRECTOR_MAX_TOOL_ROUNDS,
  DIRECTOR_MIN_TURNS_BETWEEN,
  DirectionState,
  DirectorArcPlan,
  DirectorEmitOps,
  DirectorEmitPlan,
  type DirectorOutput,
  type DirectorTrigger,
  mergeDirectorEmits,
} from "@/lib/types/direction";
import { PartialDNAScales } from "@/lib/types/dna";
import { OpeningStatePackage } from "@/lib/types/opening";
import { PremiseContract } from "@/lib/types/premise";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { adjudicateSeeds } from "./adjudication";
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
import { buildEvolutionProposal, evolutionGate, renderEvolutionReview } from "./evolution";
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

/**
 * §6.3 "semantic-with-floor": a demoted critical's source memory decays again
 * but never below this — v3's plot-critical relationship floor (g2.ts), the
 * one "critical keeps a floor" value the codebase already carries. Below the
 * hot-baseline bar (60) on purpose: demotion must free the slot.
 */
const DEMOTED_HEAT_FLOOR = 40;

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
  // M3R2 C1: the gate spaces from the last ATTEMPT, not just the last
  // success — a failing cycle backs off instead of refiring every turn
  // (the grammar-400 ratchet: accumulators only reset on success, so a
  // doomed cycle fired on every turn and burned $0.15 each time).
  const lastFired = Math.max(state.last_director_turn, state.last_director_attempt ?? 0);
  const turnsSince = turnNumber - lastFired;
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

// --- Emission ceilings (types/direction.ts carries the why) ------------------

function capList<T>(list: T[], max: number, field: string, campaignId: string): T[] {
  if (list.length <= max) return list;
  console.warn(`[director] ${field} over its ${max}-item ceiling — clamped, cycle kept`, {
    campaignId,
    emitted: list.length,
  });
  return list.slice(0, max);
}

const clampTo = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Apply the ceilings the schema can no longer enforce (the grammar strips
 * length and range bounds — types/direction.ts). Surplus entries are dropped
 * with a warn and out-of-range numbers are pinned to their band; the cycle
 * itself always survives. Axis VALUES clamp rather than drop: an out-of-band
 * value passed through would fail PartialDNAScales below and take every other
 * shift in the override down with it.
 */
function clampDirectorOutput(output: DirectorOutput, campaignId: string): DirectorOutput {
  const cap = <T>(list: T[], max: number, field: string) => capList(list, max, field, campaignId);
  // The emit halves carry no .min(1) (grammar-lean by design) and the merge
  // never re-parses through DirectorOutput — so blank-required objects drop
  // HERE with a warn, before an empty arc_name reaches the stored ArcOverride
  // or an unnamed episode closes (M3R2 C1 review).
  const blank = (v: string | undefined) => !v || v.trim() === "";
  const dropIf = (cond: boolean, field: string): boolean => {
    if (cond) {
      console.warn(`[director] ${field} with blank required text — dropped`, { campaignId });
    }
    return cond;
  };
  const arcOverride =
    output.arc_override &&
    !dropIf(
      blank(output.arc_override.arc_name) || blank(output.arc_override.transition_signal),
      "arc_override",
    )
      ? output.arc_override
      : undefined;
  const episodeClose =
    output.episode_close &&
    !dropIf(
      blank(output.episode_close.name) || blank(output.episode_close.dramatic_question),
      "episode_close",
    )
      ? output.episode_close
      : undefined;
  const evolutionProposal =
    output.evolution_proposal &&
    !dropIf(blank(output.evolution_proposal.director_case), "evolution_proposal")
      ? output.evolution_proposal
      : undefined;
  return {
    ...output,
    arc_override: arcOverride,
    episode_close: episodeClose,
    evolution_proposal: evolutionProposal,
    tension_level: clampTo(output.tension_level, 0, 1),
    scene_shape_notes: cap(
      output.scene_shape_notes,
      DIRECTOR_CAPS.scene_shape_notes,
      "scene_shape_notes",
    ),
    arc_relevance: cap(output.arc_relevance, DIRECTOR_CAPS.arc_relevance, "arc_relevance").map(
      (r) => ({ ...r, relevance: clampTo(r.relevance, 1, 9) }),
    ),
    seed_ops: cap(output.seed_ops, DIRECTOR_CAPS.seed_ops, "seed_ops"),
    spotlight_directives: cap(
      output.spotlight_directives,
      DIRECTOR_CAPS.spotlight_directives,
      "spotlight_directives",
    ),
    demote_criticals: cap(
      output.demote_criticals,
      DIRECTOR_CAPS.demote_criticals,
      "demote_criticals",
    ),
    director_notes: cap(output.director_notes, DIRECTOR_CAPS.director_notes, "director_notes"),
    voice_patterns: cap(output.voice_patterns, DIRECTOR_CAPS.voice_patterns, "voice_patterns"),
    ...(output.arc_override
      ? {
          arc_override: {
            ...output.arc_override,
            dna_shifts: cap(
              output.arc_override.dna_shifts,
              DIRECTOR_CAPS.dna_shifts,
              "dna_shifts",
            ).map((s) => ({ ...s, value: clampTo(s.value, 0, 10) })),
            composition_shifts: cap(
              output.arc_override.composition_shifts,
              DIRECTOR_CAPS.composition_shifts,
              "composition_shifts",
            ),
          },
        }
      : {}),
  };
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
    "Your personality is an instinct, never a license: the premise contract's hard lines and framing OUTRANK it. Where your instincts and the contract conflict, the contract wins - and your cruelty finds other targets.",
    "",
    "Dailies duties: judge Framing adherence qualitatively (the enums carry no numeric gauge — read the drift, don't measure it). Review the Critical layer's size with demotion restraint — demote only stale PROMOTED facts whose loss no longer breaks continuity (§6.3); the player's Session Zero facts and the contract are never yours to demote; criticality is earned and revocable, never a ratchet, and you demote, never delete.",
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

  // M3R2 C1: stamp the ATTEMPT durably before any model call — a cycle that
  // throws after this still backs off (evaluateDirectorTrigger reads the
  // stamp), instead of refiring on every subsequent turn. Surgical jsonb so
  // the wholesale state save at success (which spreads the state loaded
  // above) does not race it — the success save re-includes the stamp below.
  state.last_director_attempt = turnNumber;
  await db
    .update(campaigns)
    .set({
      directionState: sql`jsonb_set(coalesce(${campaigns.directionState}, '{}'::jsonb), '{last_director_attempt}', ${JSON.stringify(turnNumber)}::jsonb)`,
    })
    .where(eq(campaigns.id, campaignId));

  // --- The batched seed adjudication (§7.6) FIRST ---------------------------
  // Before the dossier is compiled, so the Director plans against a settled
  // ledger: organic candidates promoted or dropped, judged payoffs resolved,
  // contradicted seeds let go. Advisory, like the Sakkan: a failed
  // adjudication is a skipped batch (the next cycle re-renders the same
  // pending candidates), never a lost Director cycle.
  try {
    await adjudicateSeeds(db, campaignId, turnNumber);
  } catch (err) {
    console.warn(`[director] seed adjudication failed (turn ${turnNumber}) — batch skipped:`, err);
  }

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
    .select({
      n: sql<number>`count(*)::int`,
      promoted: sql<number>`(count(*) FILTER (WHERE ${criticalFacts.category} = 'promoted'))::int`,
    })
    .from(criticalFacts)
    .where(
      and(
        eq(criticalFacts.campaignId, campaignId),
        isNull(criticalFacts.demotedAt),
        notTombstoned(criticalFacts),
      ),
    );
  const criticalCount = critRow?.n ?? 0;
  const promotedCount = critRow?.promoted ?? 0;

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
  // The C1 flag gets its reader here (a writer with no reader is a defect,
  // axiom 8): a charter running past its §4.4a budget is a Director-visible
  // condition, not a discarded console line.
  const charterFlag = state.settei?.charter_over_target
    ? `The Style Charter is over its §4.4a budget (${state.settei.charter_tokens} tokens) — trims are exhausting; expect coarser premise pressure until the next rebuild.`
    : "";
  // Dailies consumer #3 (M2R3): drifts the gate-trip attribution charged to the
  // player. A first-class section — the exit from the eternal retake (§4.5/§8).
  const playerDrift = playerDrivenTrend(state);
  // Dailies consumer #4 (§7.1, M3 C4): the season-boundary evolution gate. Null
  // — the overwhelmingly common case — means the dossier carries no EVOLUTION
  // REVIEW at all, and any proposal the model emits anyway is discarded below.
  // Rare, evidence-gated, confident: the rarity is enforced HERE, in code.
  const gate = await evolutionGate(db, campaignId, state, contract, turnNumber);

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
    ...(charterFlag ? ["## The charter's budget", charterFlag, ""] : []),
    ...(playerDrift
      ? [
          "## Player-driven drift (§8 steering honesty + §4.2 — the story is being pulled by PLAY)",
          "The drift band measured these axes running against the premise, and the gate-trip attribution charged the divergence to the PLAYER's own inputs — not narrator wander. The retake is already CLOSED; the engine will not strain against the player (§0 authority ordering). You MAY, if it serves the story, emit a SINGLE arc_override moving the axis to where play actually lives (a dna_shift to the observed value — active layer only, latest-wins, canonical untouched), its transition_signal naming the observation gently in the fiction's own language. This is an invitation, not an order: if the pull is a passing mood, let it stand and say nothing.",
          playerDrift,
          "",
        ]
      : []),
    ...(gate ? [renderEvolutionReview(gate), ""] : []),
    "## Critical layer (§6.3 dailies review)",
    `${criticalCount} active critical fact(s), of which ${promotedCount} promoted mid-campaign. Only PROMOTED facts are demotable — Session Zero facts, the contract, and ratified retoolings are the player's, and a demote naming one is silently ignored. Demote only what has gone stale — restraint, not a purge.`,
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
    `Investigate with your tools (up to ${DIRECTOR_MAX_TOOL_ROUNDS} rounds — seeds, arc, canon, past scenes), then file your cycle in TWO emits: first the PLAN (the arc plan — name/phase/shape/budget/payoff — tension_level, any single arc_override with its transition signal — express premise shifts as axis/value pairs — OR clear_override, an episode_close when a story movement just ended, the Scene-Shape base; write '' for scene_shape_trajectory when you have no trajectory note), then, asked separately, the OPS (seed ops, criticals to demote, an arc_relevance ranking of secondary axes, spotlight directives, director notes, voice patterns). Decide BOTH during investigation; the second emit only files what you already planned.`,
    // The push-out has an op now (§7.6, M3 C2). Without saying so here, the
    // Director's only way to give a seed more room was a near-duplicate plant
    // — which is why the audit found seeds that could never leave the ledger.
    'Seed ops: "plant" (description, expected_payoff, optional window and dependencies), "resolve" and "abandon" (seed_description), and "adjust_window" — give a seed still worth keeping a LATER payoff_window_to instead of planting it again under a new description. Never re-plant a seed that already exists; push its window out or let it go on purpose. Payoffs the story lands on its own are resolved for you between cycles — plan the ones it has not.',
    // The ceilings the schema cannot carry (types/direction.ts): stated here
    // because this text IS the constraint the model writes against. Anything
    // beyond a ceiling is silently dropped engine-side — say the best ones.
    `Hard limits — emit at most: ${DIRECTOR_CAPS.scene_shape_notes} scene_shape_notes, ${DIRECTOR_CAPS.arc_relevance} arc_relevance entries, ${DIRECTOR_CAPS.seed_ops} seed_ops, ${DIRECTOR_CAPS.spotlight_directives} spotlight_directives, ${DIRECTOR_CAPS.demote_criticals} demote_criticals, ${DIRECTOR_CAPS.director_notes} director_notes, ${DIRECTOR_CAPS.voice_patterns} voice_patterns, and inside arc_override at most ${DIRECTOR_CAPS.dna_shifts} dna_shifts and ${DIRECTOR_CAPS.composition_shifts} composition_shifts. tension_level is 0-1, arc_relevance.relevance is 1-9, and every dna_shifts value is 0-10. Surplus entries are discarded, not read — rank them yourself and emit only what earns its place.`,
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

  // M3R2 C1: the final emit is TWO structured calls, not one. The grammar
  // cliff is MODEL-DEPENDENT — Haiku compiles the full DirectorOutput, Sonnet
  // 5 rejects it ("the compiled grammar is too large"), which killed every
  // cycle on the live Sonnet-judgment campaign while every DEV-tier test
  // passed. Either half compiles on Haiku, Sonnet and Opus with margin
  // (measured 2026-08-03; the schema-grammar canary keeps it true). The plan
  // half carries the investigation (tools); the ops half rides the same
  // cached persona+dossier head plus the plan's own JSON — no re-investigation.
  const plan = await callJudgment(selection, {
    name: `director_${opts?.trigger ?? "cycle"}`,
    schema: DirectorEmitPlan,
    campaignId,
    turnNumber,
    // A Director cycle rides a turn number but is not the player's turn —
    // without this the ledger files the whole cycle as play (M3 C1).
    phase: "director_cycle",
    // A tool-loop call emitting a large contract; thinking headroom is added
    // structurally on top (computeEffectiveMaxTokens), not folded in here.
    maxTokens: LOOPED_LARGE,
    effort: "high",
    system: directorPersona(contract),
    prompt: dossier,
    tools: DIRECTOR_TOOLS,
    executeTool,
    maxToolRounds: DIRECTOR_MAX_TOOL_ROUNDS,
    // M2R5 C2: persona + dossier are a 1.2–3.5k head this cycle re-sends on
    // every investigation round. 5m, not 1h — the rounds are seconds apart
    // and cycles are turns apart. Honest count (review 2026-08-03): the
    // INVESTIGATION rounds read it; the final structured emit is built
    // without tools and structurally cannot (tools render ahead of system
    // in the cache key), so the write amortizes across the rounds alone.
    cacheHead: "5m",
  });
  // NO cacheHead on the ops emit (review, 2026-08-03): its opening user block
  // is byte-different from the plan call's bare dossier, the persona alone is
  // under the cache minimum, and cycles are >=3 turns apart — a breakpoint
  // here is a 1.25x write nothing reads, the exact anti-pattern M2R5 C1
  // exists to kill. The ops half re-bills the dossier as fresh input; that is
  // the honest cost of the split, ~$0.01/cycle at Sonnet.
  const emittedOps = await callJudgment(selection, {
    name: `director_${opts?.trigger ?? "cycle"}_ops`,
    schema: DirectorEmitOps,
    campaignId,
    turnNumber,
    phase: "director_cycle",
    maxTokens: LOOPED_LARGE,
    effort: "high",
    system: directorPersona(contract),
    prompt: [
      dossier,
      "",
      "## Your plan (already filed this cycle — emit the OPS consistent with it)",
      JSON.stringify(plan),
      "",
      "You have NO tools on this request — the investigation is over; its digest is the plan's analysis. Emit the operations half directly: arc_relevance, seed_ops, spotlight_directives, demote_criticals, director_notes, voice_patterns. Sentinels: write '' or 0 for any per-op field that does not apply.",
    ].join("\n"),
  });
  const output = clampDirectorOutput(mergeDirectorEmits(plan, emittedOps), campaignId);

  // --- APPLY (§7.1) ---------------------------------------------------------
  const { arcId, phaseChanged } = await applyArcPlan(db, campaignId, turnNumber, output.arc_plan);

  if (output.episode_close) {
    await closeEpisode(db, campaignId, turnNumber, output.episode_close, arcId);
  }

  // §4.5 M2R3 steering-honesty notice + finding clear, computed during the
  // override apply and folded into the saved state below.
  let steeringNotice: DirectionState["steering_notice"];

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

    // §4.5 M2R3: if this override ANSWERS a player-driven drift (a shifted DNA
    // axis matches a pending finding), raise the one-line player notice and
    // clear the answered finding(s) — the drift is now being LED with, not
    // measured against, so the next Sakkan sample reads it in band against the
    // new effective premise and never re-raises it. Framing (composition)
    // shifts carry no numeric gauge, so only dna_shifts can answer a finding.
    const shifted = new Set(output.arc_override.dna_shifts.map((s) => s.axis));
    const pd = state.sakkan?.player_driven ?? {};
    const answered = Object.values(pd).find((f) => shifted.has(f.axis));
    if (answered) {
      steeringNotice = {
        axis: answered.axis,
        observed: answered.observed,
        set: answered.wanted,
        at_turn: turnNumber,
      };
      // Clear ONLY the noticed finding (audit): an override answering
      // several player-driven axes surfaces them SEQUENTIALLY — one notice
      // per cycle. The clear itself applies onto the FRESH sakkan at save
      // (freshSakkanCleared below) so a sample landing mid-cycle survives.
    }
  } else if (output.clear_override) {
    await db.update(campaigns).set({ arcOverride: null }).where(eq(campaigns.id, campaignId));
  }

  // Per-op isolation (M3R2 C1 review): the sentinel contract makes empty
  // strings reachable and plantSeed throws hard on one — a bad op skips with
  // its reason logged; it must never lose a half-applied cycle mid-loop.
  for (const op of output.seed_ops) {
    if (op.op === "plant" && !op.description?.trim()) {
      console.warn("[director] plant op with empty description — dropped", { campaignId });
      continue;
    }
    try {
      if (op.op === "plant") {
        await plantSeed(db, campaignId, turnNumber, op, DIRECTOR_PROVENANCE);
      } else {
        await settleSeed(db, campaignId, turnNumber, op);
      }
    } catch (err) {
      console.warn(`[director] seed op ${op.op} failed — skipped, cycle kept`, {
        campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // §6.3: demotion, not erasure — set demotedAt, never delete. Only PROMOTED
  // facts are demotable: they alone came FROM the semantic layer, so "back to
  // semantic-with-floor" has somewhere to land. sz_fact and contract rows are
  // player authority (premise laws, hard lines, assertions) with no semantic
  // copy — a demotion there would drop the player's own words from every
  // reader, and the ILIKE containment match makes accidental hits real. The
  // §7.1 player_ratified retoolings are fenced by the same guard (C4 audit:
  // one model-chosen phrase must never drop them out of the bible).
  for (const match of output.demote_criticals) {
    if (!match.trim()) continue;
    // Literal containment, not pattern matching: %/_ in the model's string
    // ("50% morale") are live ILIKE wildcards unless escaped — unescaped they
    // over-demote facts the Director never named (C7 audit).
    const literal = match.replace(/([\\%_])/g, "\\$1");
    // One transaction per match: a demote that lands without its re-home has
    // no retry path (isNull(demotedAt) never matches again), so the source's
    // no-decay pin would ratchet on forever.
    await db.transaction(async (tx) => {
      const demoted = await tx
        .update(criticalFacts)
        .set({ demotedAt: new Date(), demotedAtTurn: turnNumber })
        .where(
          and(
            eq(criticalFacts.campaignId, campaignId),
            eq(criticalFacts.category, "promoted"),
            isNull(criticalFacts.demotedAt),
            notTombstoned(criticalFacts),
            sql`${criticalFacts.content} ILIKE ${`%${literal}%`}`,
          ),
        )
        .returning({ id: criticalFacts.id, sourceMemoryId: criticalFacts.sourceMemoryId });
      // Re-home: release the source memory's no-decay pin (curve 1.0 + the
      // +0.3 retrieval bonus + a permanent hot-baseline slot would ratchet on)
      // and leave it a floor — "semantic-with-floor" made literal.
      const sourceIds = demoted
        .map((d) => d.sourceMemoryId)
        .filter((id): id is string => id !== null);
      if (sourceIds.length > 0) {
        // Snapshot the pre-demotion pin BEFORE the re-home overwrites it: a
        // rewind past this demotion restores from the undo (§6.7), and
        // GREATEST() below is lossy.
        const preValues = await tx
          .select({
            id: semanticMemories.id,
            plotCritical: semanticMemories.plotCritical,
            heatFloor: semanticMemories.heatFloor,
          })
          .from(semanticMemories)
          .where(and(inArray(semanticMemories.id, sourceIds), notTombstoned(semanticMemories)));
        const preById = new Map(preValues.map((p) => [p.id, p]));
        for (const row of demoted) {
          const pre = row.sourceMemoryId ? preById.get(row.sourceMemoryId) : undefined;
          if (pre) {
            await tx
              .update(criticalFacts)
              .set({
                demotionUndo: { plot_critical: pre.plotCritical, heat_floor: pre.heatFloor },
              })
              .where(eq(criticalFacts.id, row.id));
          }
        }
        await tx
          .update(semanticMemories)
          .set({
            plotCritical: false,
            heatFloor: sql`GREATEST(${semanticMemories.heatFloor}, ${DEMOTED_HEAT_FLOOR})`,
          })
          .where(and(inArray(semanticMemories.id, sourceIds), notTombstoned(semanticMemories)));
      }
    });
  }

  // §7.1 (M3 C4): the season-boundary proposal AMENDS NOTHING here. It lands on
  // the state and waits for the player's word on the play surface — ratification
  // is explicit, and an unanswered proposal never expires into a yes. A proposal
  // emitted without an open gate is the anxious check-in §7.1 forbids: dropped.
  let evolutionProposal: DirectionState["evolution_proposal"];
  if (output.evolution_proposal) {
    if (gate) {
      evolutionProposal =
        buildEvolutionProposal(output.evolution_proposal, gate, turnNumber) ?? undefined;
    } else {
      console.warn("[director] evolution_proposal emitted with no open season gate — dropped", {
        campaignId,
        turnNumber,
      });
    }
  }

  const relevanceRecord: Record<string, number> = {};
  for (const r of output.arc_relevance) relevanceRecord[r.axis] = r.relevance;

  // The final save spreads FRESH state, not the snapshot loaded before two
  // model emits (M3R2 C1 review): a Sakkan sample or a Layout flag landing
  // mid-cycle must not be clobbered by a stale wholesale write. Cycle-owned
  // fields overwrite below; the answered-finding clear re-applies onto the
  // FRESH sakkan by axis; flags consumed by this dossier drop, flags added
  // mid-cycle survive.
  const fresh = await loadDirectionState(db, campaignId);
  const consumedFlags = new Set(state.pending_flags);
  const freshSakkanCleared =
    steeringNotice && fresh.sakkan
      ? {
          ...fresh.sakkan,
          player_driven: Object.fromEntries(
            Object.entries(fresh.sakkan.player_driven ?? {}).filter(
              ([axis]) => axis !== steeringNotice?.axis,
            ),
          ),
        }
      : undefined;

  const newState: DirectionState = {
    ...fresh,
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
    // §4.5 M2R3: the answered player-driven finding cleared, the notice raised.
    ...(freshSakkanCleared ? { sakkan: freshSakkanCleared } : {}),
    ...(steeringNotice ? { steering_notice: steeringNotice } : {}),
    // A pending proposal rides through `...state` untouched: silence persists
    // the card across cycles until the player answers it (§7.1).
    ...(evolutionProposal ? { evolution_proposal: evolutionProposal } : {}),
    // Accumulators reset; the trigger begins re-arming from here.
    accumulated_epicness: 0,
    arc_events: [],
    pending_flags: fresh.pending_flags.filter((f) => !consumedFlags.has(f)),
    last_director_turn: turnNumber,
    last_director_attempt: turnNumber,
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

/** Unbounded for the same reason DirectorOutput is (types/direction.ts): a
 *  sixth cold-open constraint must not cost the campaign its pilot plan. */
export const StartupPlan = z.object({
  arc: DirectorArcPlan,
  cold_open_constraints: z.array(z.string()).default([]),
  scene_shape_notes: z.array(z.string()).default([]),
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
    `Plan the OPENING ARC. Name it (IP-appropriate, evocative), set phase to Setup, give it a dramatic_question descending from the spark, its shape and a budget within tolerance of the prior. Then: at most ${DIRECTOR_CAPS.cold_open_constraints} cold_open_constraints and at most ${DIRECTOR_CAPS.scene_shape_notes} scene_shape_notes for the writer's first scene — surplus entries are discarded, not read. Do NOT restate the forbidden opening moves — those pass through as hard constraints, verbatim.`,
  ].join("\n");

  const plan = await callJudgment(selection, {
    name: "director_startup",
    schema: StartupPlan,
    campaignId,
    turnNumber: 0,
    phase: "director_cycle",
    maxTokens: LOOPED_LARGE,
    effort: "high",
    system: directorPersona(contract),
    prompt: dossier,
  });

  const { arcId } = await applyArcPlan(db, campaignId, 0, plan.arc);

  const newState: DirectionState = {
    ...state,
    tension_level: 0.2,
    phase_state: { arc_id: arcId, phase: plan.arc.phase, entered_at_turn: 0 },
    scene_shape: {
      notes: capList(
        plan.scene_shape_notes,
        DIRECTOR_CAPS.scene_shape_notes,
        "scene_shape_notes",
        campaignId,
      ),
    },
    pilot_plan: {
      cold_open_constraints: capList(
        plan.cold_open_constraints,
        DIRECTOR_CAPS.cold_open_constraints,
        "cold_open_constraints",
        campaignId,
      ),
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
 * "session_open" — reads the last session memo, refreshes the plan. Backoff
 * rides for free (M3R2 C1): the cycle stamps last_director_attempt before
 * any model call, so the G2 trigger after this open spaces from it — an
 * open-time review never double-fires the same turn, and a FAILING review
 * costs at most one attempt per human-paced open.
 */
export async function directorReview(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<void> {
  await runDirectorCycle(db, campaignId, turnNumber, { trigger: "session_open" });
}
