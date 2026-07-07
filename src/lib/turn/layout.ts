import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  consequences,
  episodicRecords,
  overrides,
  pencilMarks,
  turns,
} from "@/lib/db/schema";
import { selectSakugaMode } from "@/lib/ka/sakuga";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { renderAmendments } from "@/lib/renderer/amendments";
import { renderSceneShape } from "@/lib/renderer/scene-shape";
import { Conte } from "@/lib/types/conte";
import { PencilMark } from "@/lib/types/marks";
import { PremiseContract } from "@/lib/types/premise";
import { IntentOutput, TURN_CONTRACTS, type TurnEffort } from "@/lib/types/turn";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { PHASE_A_BUDGET_MS, createDegradeClock } from "./degrade";
import { judgeOutcome, syntheticOutcome, validateOutcome } from "./outcome";
import { pacerMicroCheck } from "./pacer";
import { powerContext } from "./power";
import {
  decomposeQueries,
  fetchCallbacks,
  fetchCandidates,
  fetchCanon,
  fetchCritical,
  fetchEntityCards,
  recordBoosts,
  relevanceFilter,
  toConteMemories,
} from "./retrieval";
import { judgeScale } from "./scale";
import { classifyTier, isChannelInput } from "./triage";

/**
 * Layout — Phase A as the §5.1 DAG. The intent probe IS the triage call;
 * the contract binds from retrieval onward; outcome judgment joins on
 * retrieval; the conte assembles in code and checkpoints to `turns` the
 * moment Phase A completes (retry-same-dice substrate, §5.7).
 */

export interface LayoutEvent {
  type: "staging";
  text: string;
}

export type LayoutResult =
  | {
      kind: "conte";
      conte: Conte;
      intent: IntentOutput;
      /** Post-promotion effort (escalation beats run ≥ high — §3 caveat). */
      effort: TurnEffort;
      turnRowId: string;
    }
  | {
      /** §5.4 channel input — not a scene turn; responders land C6/C9. */
      kind: "channel";
      intent: IntentOutput;
    };

const INTENT_SYSTEM = [
  "You are the Phase-A parse: classify the player's input for the turn",
  "engine. intent: the PRIMARY channel (COMBAT/SOCIAL/EXPLORATION/ABILITY/",
  "INVENTORY/WORLD_BUILDING for story actions; META_FEEDBACK for",
  "out-of-fiction talk to the studio; OVERRIDE_COMMAND for standing-rule",
  "demands; OP_COMMAND for explicit mechanical cheats/admin). epicness 0-1:",
  "how large this beat wants to play (0.1 = walking to the shop, 0.5 = a",
  "charged confrontation, 0.9 = the season's peak). special_conditions:",
  "TROPE flags only, from this vocabulary: transformation, sacrifice_play,",
  "named_attack, unleashed_form, last_stand, power_reveal, breaking_point.",
  "These route the scene to full craft budget — NEVER flag ordinary",
  "approach descriptors (stealth, caution, speed, thoroughness); almost",
  "every turn has NO flags. confidence: your certainty in the primary",
  "intent.",
].join(" ");

export async function runLayout(
  db: Db,
  campaignId: string,
  turnNumber: number,
  playerInput: string,
  emit: (e: LayoutEvent) => void = () => {},
): Promise<LayoutResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("campaign not found");
  const contract = PremiseContract.parse(campaign.premiseContract);
  const parsedSelection = TierSelection.safeParse(campaign.tierModels);
  const selection = parsedSelection.success ? parsedSelection.data : DEV_TIER_SELECTION;

  // --- Triage: the intent probe IS the triage call (§5.1) -------------------
  emit({ type: "staging", text: "reading the room" });
  const [lastEpisodic] = await db
    .select({ narration: episodicRecords.narration })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(1);
  const intent = await callProbe(selection, {
    name: "intent_triage",
    schema: IntentOutput,
    campaignId,
    turnNumber,
    system: INTENT_SYSTEM,
    prompt: [
      lastEpisodic ? `PREVIOUS SCENE (tail): …${lastEpisodic.narration.slice(-600)}` : "",
      `PLAYER INPUT: ${playerInput}`,
    ]
      .filter(Boolean)
      .join("\n"),
    maxTokens: 1_500,
  });

  if (isChannelInput(intent)) {
    return { kind: "channel", intent };
  }

  const tier = classifyTier(intent);
  const turnContract = TURN_CONTRACTS[tier];
  const ladder = createDegradeClock(PHASE_A_BUDGET_MS[tier] ?? 12_000, (step, ms) => {
    console.warn(`[layout] degrade ladder fired: ${step} at ${ms}ms (turn ${turnNumber})`);
    emit({ type: "staging", text: `running long — ${step.replaceAll("_", " ")}` });
  });
  // Progressive: at most ONE rung per stage boundary (§5.5's order is a
  // sequence of mitigations, not a drain — firing the whole ladder at once
  // strips a healthy turn's brief, which the doctrine forbids).
  const applyLadder = () => {
    if (ladder.shouldDegrade()) ladder.fire();
  };

  // --- Parallel fan-out (§5.1 DAG) -------------------------------------------
  emit({ type: "staging", text: "gathering what matters" });
  const world = contract.active.world;
  const worldBaseline = Number.parseInt(world.power_distribution.typical_tier.slice(1), 10);
  // Protagonist tier: campaign mechanical state owns this from C6; until a
  // sheet exists, the premise's typical tier is the honest default (diff 0).
  const characterTier = worldBaseline;
  const pContext = powerContext(characterTier, worldBaseline);

  const situation = lastEpisodic?.narration.slice(-300);
  const queries = decomposeQueries(intent, playerInput, situation);

  const [
    retrieved,
    canon,
    entityCards,
    callbacks,
    critical,
    activeOverrides,
    activeConsequences,
    pacer,
    freshMarksRaw,
  ] = await Promise.all([
    turnContract.retrievalCandidates > 0
      ? fetchCandidates(db, campaignId, turnNumber, queries, turnContract.retrievalCandidates)
      : Promise.resolve([]),
    turnContract.retrievalCandidates > 0
      ? fetchCanon(
          db,
          contract.anchors_used,
          intent,
          `${queries[0] ?? playerInput} ${situation ?? ""}`.trim(),
          turnContract.canonFanOut,
        )
      : Promise.resolve([]),
    fetchEntityCards(db, campaignId, playerInput),
    fetchCallbacks(db, campaignId, turnNumber),
    fetchCritical(db, campaignId),
    db
      .select({ content: overrides.content })
      .from(overrides)
      .where(
        and(
          eq(overrides.campaignId, campaignId),
          eq(overrides.active, true),
          notTombstoned(overrides),
        ),
      ),
    db
      .select({ description: consequences.description })
      .from(consequences)
      .where(
        and(
          eq(consequences.campaignId, campaignId),
          eq(consequences.active, true),
          notTombstoned(consequences),
        ),
      )
      .limit(8),
    turnContract.consultants.includes("pacer") && !ladder.has("timebox_pacer")
      ? pacerMicroCheck(selection, {
          intent,
          playerInput,
          recentBeats: [],
          campaignId,
          turnNumber,
        })
      : Promise.resolve({ promoteEffort: false, timedOut: false, beat: undefined }),
    db
      .select()
      .from(pencilMarks)
      .where(
        and(
          eq(pencilMarks.campaignId, campaignId),
          gt(pencilMarks.turnId, Math.max(0, turnNumber - 10)),
          notTombstoned(pencilMarks),
        ),
      ),
  ]);
  applyLadder();

  // --- Relevance filter (part of the prescription budget, §6.4) --------------
  const filtered =
    retrieved.length > 0
      ? await relevanceFilter(selection, retrieved, intent, playerInput, { campaignId, turnNumber })
      : [];
  applyLadder();

  // --- Outcome judgment (joins on retrieval; §5.1 hard core) -----------------
  emit({ type: "staging", text: "judging the outcome" });
  let judgment = turnContract.consultants.includes("outcome")
    ? await judgeOutcome(selection, {
        intent,
        playerInput,
        powerContext: pContext,
        memories: filtered.map((m) => m.content),
        campaignId,
        turnNumber,
      })
    : syntheticOutcome();
  applyLadder();

  // --- Validation (sakuga; one retry re-judges the SAME die) -----------------
  if (turnContract.validationRetry && !ladder.has("skip_validation_retry")) {
    const verdict = await validateOutcome(selection, {
      outcome: judgment.outcome,
      intent,
      playerInput,
      powerContext: pContext,
      campaignId,
      turnNumber,
    });
    if (!verdict.is_valid && verdict.correction) {
      judgment = await judgeOutcome(selection, {
        intent,
        playerInput,
        powerContext: pContext,
        memories: filtered.map((m) => m.content),
        correction: verdict.correction,
        campaignId,
        turnNumber,
        roll: judgment.roll,
      });
    }
  }
  applyLadder();

  // --- Combat pre-resolution (combat only; needs outcome + scale) ------------
  if (intent.intent === "COMBAT" && turnContract.consultants.includes("scale")) {
    emit({ type: "staging", text: "setting the scale" });
    const scale = await judgeScale(selection, {
      intent,
      playerInput,
      characterTier,
      worldBaselineTier: worldBaseline,
      memories: filtered.map((m) => m.content),
      campaignId,
      turnNumber,
    });
    judgment.mechanics.combat_results = scale.directive;
  }

  // Typed resource spends parse from the judge's cost line when it names
  // amounts ("20 MP") — costs-rare doctrine means usually there are none.
  // Spends checkpoint here; state application is Compositor G1 (C6).
  const costText = judgment.outcome.cost ?? "";
  for (const m of costText.matchAll(/(\d+)\s*(MP|SP|HP|stamina|mana|energy)/gi)) {
    judgment.mechanics.resource_spends.push({
      resource: (m[2] ?? "").toUpperCase(),
      amount: Number(m[1]),
    });
  }

  // --- Conte assembly (code) --------------------------------------------------
  emit({ type: "staging", text: "assembling the storyboard" });
  const freshMarks = freshMarksRaw
    .map((r) =>
      PencilMark.safeParse({
        kind: r.kind,
        topic: r.topic,
        direction: r.direction,
        evidence: r.evidence ?? "",
        turn_id: r.turnId,
        confidence: r.confidence,
      }),
    )
    .filter((p) => p.success)
    .map((p) => p.data);
  const amendments = renderAmendments({
    arcOverride: campaign.arcOverride as Parameters<typeof renderAmendments>[0]["arcOverride"],
    sakkanNotes: [],
    freshMarks,
  });
  const sceneShape = renderSceneShape(contract.active.framing, {});
  const canonicality = contract.active.canonicality;
  const canonicalityDirectives = [
    `Timeline: ${canonicality.timeline_mode}; cast: ${canonicality.canon_cast_mode}; events: ${canonicality.event_fidelity}.`,
    ...canonicality.forbidden_contradictions.map((f) => `NEVER contradict: ${f}`),
  ];
  const sakuga = selectSakugaMode(intent, judgment.outcome);
  const minimal = ladder.has("minimal_brief");

  const conte = Conte.parse({
    turn_id: turnNumber,
    tier: ladder.has("drop_to_genga") && tier === "sakuga" ? "genga" : tier,
    outcome: judgment.outcome,
    mechanics: judgment.mechanics,
    charter_amendments: amendments.text,
    scene_shape_directive: minimal ? "" : sceneShape.text,
    pacer_beat: pacer.beat,
    canonicality_directives: canonicalityDirectives,
    hard_constraints: [...critical, ...activeOverrides.map((o) => o.content)],
    callbacks: minimal ? [] : callbacks,
    memories: minimal ? [] : toConteMemories(filtered),
    canon_chunks: minimal ? [] : canon,
    entity_cards: minimal ? [] : entityCards,
    spotlight_hints: [],
    active_consequences: minimal ? [] : activeConsequences.map((c) => c.description),
    world_assertion_notes: [],
    sakuga_mode: sakuga?.mode,
    research_findings: [],
    degraded: ladder.state.degraded,
  });

  // --- Checkpoint: Phase A persists the moment it completes (§5.7) -----------
  const [row] = await db
    .insert(turns)
    .values({
      campaignId,
      turnNumber,
      tier: conte.tier,
      status: "phase_a_complete",
      playerInput,
      conte,
      degraded: conte.degraded,
      checkpoints: { phase_a: true },
    })
    .onConflictDoUpdate({
      target: [turns.campaignId, turns.turnNumber],
      set: {
        tier: conte.tier,
        status: "phase_a_complete",
        playerInput,
        conte,
        degraded: conte.degraded,
        checkpoints: sql`${turns.checkpoints} || '{"phase_a": true}'::jsonb`,
      },
    })
    .returning({ id: turns.id });
  if (!row) throw new Error("phase-A checkpoint write failed");

  // Boost accumulation: write-only seam until C6's G2 UPDATE binds.
  await recordBoosts(db, campaignId, turnNumber, filtered);

  const effort: TurnEffort =
    pacer.promoteEffort && turnContract.effort === "low" ? "high" : turnContract.effort;

  return { kind: "conte", conte, intent, effort, turnRowId: row.id };
}
