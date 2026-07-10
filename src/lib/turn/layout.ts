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
import { getActiveArc } from "@/lib/direction/arcs";
import { saveDirectionState } from "@/lib/direction/director";
import { ingestAssertion } from "@/lib/ingestion/ingest";
import { type RepetitionReadings, measureRepetition } from "@/lib/ka/antirep";
import { selectSakugaMode } from "@/lib/ka/sakuga";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { renderAmendments } from "@/lib/renderer/amendments";
import { renderSceneShape } from "@/lib/renderer/scene-shape";
import { activeSakkanNotes } from "@/lib/sakkan/sakkan";
import { Conte } from "@/lib/types/conte";
import { DirectionState, type PacerArcState, PacerPhase } from "@/lib/types/direction";
import { PencilMark } from "@/lib/types/marks";
import { PremiseContract } from "@/lib/types/premise";
import { IntentOutput, TURN_CONTRACTS, type TurnEffort } from "@/lib/types/turn";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { type LadderStep, PHASE_A_BUDGET_MS, createDegradeClock } from "./degrade";
import { judgeOutcome, syntheticOutcome, validateOutcome } from "./outcome";
import { runPacer } from "./pacer";
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
      /** Degrade rungs fired (§5.5) — Phase B consumes cap_research_* (C5). */
      ladderSteps: LadderStep[];
      turnRowId: string;
      /** §5.4 ingestion verdicts for honest in-stream surfacing (C9). */
      assertion?: { writes: string[]; clarify?: string; flags: string[] };
    }
  | {
      /** §5.4 channel input — the runtime dispatches booth/override (C9). */
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
  const direction = DirectionState.parse(campaign.directionState ?? {});

  // --- Triage: the intent probe IS the triage call (§5.1) -------------------
  emit({ type: "staging", text: "reading the room" });
  const [lastEpisodic] = await db
    .select({ narration: episodicRecords.narration })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(1);
  // Direction reads ride the triage call's latency (indexed, ms-scale).
  const [intent, activeArc, recentTurnRows] = await Promise.all([
    callProbe(selection, {
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
    }),
    getActiveArc(db, campaignId),
    db
      .select({ conte: turns.conte })
      .from(turns)
      .where(and(eq(turns.campaignId, campaignId), eq(turns.status, "complete")))
      .orderBy(desc(turns.turnNumber))
      .limit(3),
  ]);

  if (isChannelInput(intent)) {
    return { kind: "channel", intent };
  }

  // Arc state for the Pacer (§7.2): phase ownership is the Director's —
  // phase_state only counts when it points at the CURRENT active arc.
  const phaseOwned = direction.phase_state?.arc_id === activeArc?.id;
  const parsedPhase = PacerPhase.safeParse(
    phaseOwned ? direction.phase_state?.phase : activeArc?.phase,
  );
  const arcState: PacerArcState | null = activeArc
    ? {
        phase: parsedPhase.success ? parsedPhase.data : "setup",
        turnsInPhase:
          phaseOwned && direction.phase_state
            ? Math.max(0, turnNumber - direction.phase_state.entered_at_turn)
            : 0,
        tensionLevel: direction.tension_level,
        arcName: activeArc.name,
        shape: activeArc.shape,
      }
    : null;
  const recentBeats = recentTurnRows
    .map((r) => (r.conte as Conte | null)?.pacer_beat?.beat_classification)
    .filter((b): b is string => Boolean(b));

  const tier = classifyTier(intent);
  const turnContract = TURN_CONTRACTS[tier];
  const ladder = createDegradeClock(PHASE_A_BUDGET_MS[tier] ?? 12_000, (step, ms) => {
    console.warn(`[layout] degrade ladder fired: ${step} at ${ms}ms (turn ${turnNumber})`);
    emit({ type: "staging", text: `running long — ${step.replaceAll("_", " ")}` });
  });
  // Threshold-progressive: each rung has its own overrun multiple, so a
  // mildly-late turn fires one rung and only a catastrophic stall reaches
  // the §5.5 terminal fallback — the while-loop can't drain a healthy turn.
  const applyLadder = () => {
    while (ladder.shouldDegrade()) ladder.fire();
  };

  // --- Parallel fan-out (§5.1 DAG) -------------------------------------------
  emit({ type: "staging", text: "gathering what matters" });
  const world = contract.active.world;
  // §5.3 anti-repetition whitelist: IP jargon the phrase-repetition check must
  // never flag — power-system name + on-screen stat/resource names.
  const jargonWhitelist = [
    world.power_system?.name,
    world.stat_mapping.system_name,
    ...Object.keys(world.stat_mapping.aliases),
    ...Object.keys(world.stat_mapping.meta_resources),
  ].filter((s): s is string => Boolean(s));
  const worldBaseline = Number.parseInt(world.power_distribution.typical_tier.slice(1), 10);
  // Protagonist tier: campaign mechanical state owns this from C6; until a
  // sheet exists, the premise's typical tier is the honest default (diff 0).
  const characterTier = worldBaseline;
  const pContext = powerContext(characterTier, worldBaseline);

  const situation = lastEpisodic?.narration.slice(-300);
  const queries = decomposeQueries(intent, playerInput, situation);

  // §5.3 anti-repetition detection joins the fan-out for genga/sakuga (douga
  // never — a trivial beat carries no measured pressure). Its own catch keeps
  // a detection failure from ever rejecting the fan-out and blocking the turn.
  const repetitionProbe: Promise<RepetitionReadings> =
    tier === "douga"
      ? Promise.resolve({})
      : measureRepetition(db, campaignId, { jargonWhitelist }).catch((err) => {
          console.warn(`[layout] anti-repetition detection failed (turn ${turnNumber}): ${err}`);
          return {} as RepetitionReadings;
        });

  // §5.4 universal ingestion: a WORLD_BUILDING turn is BOTH world-building
  // and a scene beat — extraction captures the facts (entities minted or
  // enriched, semantic rows embedded), the conte carries integration notes
  // so the narrated scene keeps the vibe. A CLARIFY surfaces diegetically;
  // FLAGs are Director territory (C7 reads them; logged until then).
  // Failure never blocks the turn. Phase-A re-runs may re-ingest (noted:
  // duplicate semantic facts are noise, not corruption — G2's distillation
  // dedups nothing at M1).
  const ingestionProbe: Promise<{
    notes: string[];
    flags: string[];
    writes: string[];
    clarify?: string;
  }> =
    intent.intent === "WORLD_BUILDING"
      ? ingestAssertion(db, campaignId, turnNumber, playerInput, {
          profileIds: contract.anchors_used,
          provenance: "player_assertion",
        })
          .then((r) => {
            const notes = r.writes.map((w) => `Established fact (${w.kind}): ${w.summary}`);
            if (r.clarify) {
              notes.push(
                `The assertion left a genuine ambiguity — let the scene surface it naturally: ${r.clarify}`,
              );
            }
            return {
              notes,
              flags: r.flags,
              writes: r.writes.map((w) => w.summary),
              ...(r.clarify ? { clarify: r.clarify } : {}),
            };
          })
          .catch((err) => {
            console.warn(`[layout] ingestion failed (turn ${turnNumber}): ${err}`);
            return { notes: [], flags: [], writes: [] };
          })
      : Promise.resolve({ notes: [], flags: [], writes: [] });

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
    repetition,
    worldAssertionNotes,
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
    // §5.1 douga row: retrieval is NONE — critical block only. Entity cards
    // and callbacks are fan-out members, so they're tier-gated too.
    turnContract.retrievalCandidates > 0
      ? fetchEntityCards(db, campaignId, playerInput)
      : Promise.resolve([]),
    turnContract.retrievalCandidates > 0
      ? fetchCallbacks(db, campaignId, turnNumber)
      : Promise.resolve([]),
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
    turnContract.retrievalCandidates > 0
      ? db
          .select({ description: consequences.description })
          .from(consequences)
          .where(
            and(
              eq(consequences.campaignId, campaignId),
              eq(consequences.active, true),
              notTombstoned(consequences),
            ),
          )
          .limit(8)
      : Promise.resolve([]),
    turnContract.consultants.includes("pacer") && !ladder.has("timebox_pacer")
      ? runPacer(selection, {
          intent: `${intent.intent}, epicness ${intent.epicness.toFixed(2)}`,
          playerInput,
          recentBeats,
          arcState,
          campaignId,
          turnNumber,
        })
      : Promise.resolve<import("./pacer").PacerResult>({ promoteEffort: false, timedOut: false }),
    // Amendments window (§4.4a/b): marks since the last session-open Settei
    // rebuild ride the Amendments; the rebuild bakes them into the Charter.
    // Pre-C7 campaigns (no snapshot yet) keep the legacy 10-turn window.
    db
      .select()
      .from(pencilMarks)
      .where(
        and(
          eq(pencilMarks.campaignId, campaignId),
          gt(pencilMarks.turnId, direction.settei?.rebuilt_at_turn ?? Math.max(0, turnNumber - 10)),
          notTombstoned(pencilMarks),
        ),
      ),
    repetitionProbe,
    ingestionProbe,
  ]);
  applyLadder();

  // Ingestion FLAGs are Director territory (§5.4): queue them for the next
  // dailies review. Layout is the turn's only DirectionState writer and the
  // prior turn's G2 has drained by now (settleG2IfPending at submit).
  if (worldAssertionNotes.flags.length > 0) {
    direction.pending_flags = [...direction.pending_flags, ...worldAssertionNotes.flags].slice(-20);
    await saveDirectionState(db, campaignId, direction);
  }

  // --- Relevance filter (part of the prescription budget, §6.4) --------------
  const filtered =
    retrieved.length > 0
      ? await relevanceFilter(selection, retrieved, intent, playerInput, situation, {
          campaignId,
          turnNumber,
        })
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
  // Final boundary before assembly: the terminal rungs (drop_to_genga,
  // minimal_brief) must be able to engage on a catastrophically slow turn.
  applyLadder();

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
  // id + provenance are REQUIRED by PencilMark — omitting them failed every
  // safeParse and silently dropped ALL fresh marks from the Amendments
  // (caught by the C7 session agent; same defect fixed in blocks/campaign.ts).
  const freshMarks = freshMarksRaw
    .map((r) =>
      PencilMark.safeParse({
        id: r.id,
        kind: r.kind,
        topic: r.topic,
        direction: r.direction,
        evidence: r.evidence ?? "",
        turn_id: r.turnId,
        provenance: r.provenance,
        confidence: r.confidence,
      }),
    )
    .filter((p) => p.success)
    .map((p) => p.data);
  const amendments = renderAmendments({
    arcOverride: campaign.arcOverride as Parameters<typeof renderAmendments>[0]["arcOverride"],
    // C1's typed input finally has its producer (C8): active retakes ride
    // every conte until the axis reads back in band (§4.5).
    sakkanNotes: activeSakkanNotes(direction),
    freshMarks,
  });
  // Scene-Shape Directive (§4.4c): the Director is the producer (C7) — arc
  // line from the active arc, trajectory + notes from the last cycle. The
  // pilot plan rides turn 1 keyed on turn NUMBER, not a consumed flag, so a
  // Phase-A crash-replay re-injects identically (§5.7 re-entrancy).
  const sceneShape = renderSceneShape(contract.active.framing, {
    arcName: activeArc?.name,
    phase: arcState?.phase,
    trajectoryNote: direction.scene_shape?.trajectory_note,
  });
  const directorNotes = [
    ...(direction.scene_shape?.notes ?? []),
    ...direction.director_notes,
  ].slice(0, 3);
  const pilot = turnNumber === 1 ? direction.pilot_plan : undefined;
  let sceneShapeText = sceneShape.text;
  if (directorNotes.length > 0) {
    sceneShapeText += `\n${directorNotes.map((n) => `Director: ${n}`).join("\n")}`;
  }
  if (pilot?.opening_pov) {
    sceneShapeText += `\nOpening POV: ${pilot.opening_pov}`;
  }
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
    scene_shape_directive: minimal ? "" : sceneShapeText,
    // §5.5 rung 2: "proceed without its directive" — the beat is dropped
    // when the rung fired, even though the probe itself already resolved.
    pacer_beat: ladder.has("timebox_pacer") ? undefined : pacer.beat,
    canonicality_directives: canonicalityDirectives,
    // Pilot constraints (§8 handoff, ratified pilot-as-normal-turn): the
    // OSP's forbidden opening moves + the Director's cold-open constraints
    // are hard core on turn 1 — they survive even a minimal brief.
    hard_constraints: [
      ...critical,
      ...activeOverrides.map((o) => o.content),
      ...(pilot?.forbidden_opening_moves.map((m) => `FORBIDDEN OPENING MOVE: ${m}`) ?? []),
      ...(pilot?.cold_open_constraints ?? []),
    ],
    callbacks: minimal ? [] : callbacks,
    memories: minimal ? [] : toConteMemories(filtered),
    canon_chunks: minimal ? [] : canon,
    entity_cards: minimal ? [] : entityCards,
    // The Director's spotlight directives (§7.1) — refreshed each cycle.
    spotlight_hints: minimal
      ? []
      : direction.spotlight_directives.map((d) => `${d.name}: ${d.note}`),
    active_consequences: minimal ? [] : activeConsequences.map((c) => c.description),
    // World assertions survive even a minimal brief — player-authored canon
    // is hard core, not garnish (§5.4).
    world_assertion_notes: worldAssertionNotes.notes,
    // §5.3 diversity injections — measured, and dropped under a minimal brief.
    style_drift_directive: minimal ? undefined : repetition.styleDriftDirective,
    vocab_freshness_advisory: minimal ? undefined : repetition.vocabFreshnessAdvisory,
    sakuga_mode: sakuga?.mode,
    research_findings: [],
    degraded: ladder.state.degraded,
  });

  // --- Checkpoint: Phase A persists the moment it completes (§5.7) -----------
  // epicness + the pacer's phase-transition suggestion ride the checkpoints
  // so G2's Director trigger (step 11) can fold this turn into the
  // accumulators without re-deriving Phase-A judgments.
  const checkpointPatch = {
    phase_a: true,
    ladder: ladder.state.fired,
    epicness: intent.epicness,
    pacer_transition: pacer.phaseTransition ?? null,
  };
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
      checkpoints: checkpointPatch,
    })
    .onConflictDoUpdate({
      target: [turns.campaignId, turns.turnNumber],
      set: {
        tier: conte.tier,
        status: "phase_a_complete",
        playerInput,
        conte,
        degraded: conte.degraded,
        checkpoints: sql`${turns.checkpoints} || ${JSON.stringify(checkpointPatch)}::jsonb`,
      },
    })
    .returning({ id: turns.id });
  if (!row) throw new Error("phase-A checkpoint write failed");

  // Boost accumulation: write-only seam until C6's G2 UPDATE binds.
  await recordBoosts(db, campaignId, turnNumber, filtered);

  const effort: TurnEffort =
    pacer.promoteEffort && turnContract.effort === "low" ? "high" : turnContract.effort;

  const hasAssertion =
    worldAssertionNotes.writes.length > 0 ||
    worldAssertionNotes.clarify !== undefined ||
    worldAssertionNotes.flags.length > 0;

  return {
    kind: "conte",
    conte,
    intent,
    effort,
    ladderSteps: [...ladder.state.fired],
    turnRowId: row.id,
    ...(hasAssertion
      ? {
          assertion: {
            writes: worldAssertionNotes.writes,
            ...(worldAssertionNotes.clarify ? { clarify: worldAssertionNotes.clarify } : {}),
            flags: worldAssertionNotes.flags,
          },
        }
      : {}),
  };
}
