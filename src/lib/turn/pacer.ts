import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callProbe } from "@/lib/llm/calls";
import { MODEL_CAPS, type TierSelection } from "@/lib/llm/tiers";
import type { PacerBeat } from "@/lib/types/conte";
import {
  ESCALATION_BANDS,
  PACER_PHASES,
  PHASE_GATES,
  type PacerArcState,
  PacerDirective,
  TENSION_CLIMAX_SUGGEST,
} from "@/lib/types/direction";
import { TURN_CONTRACTS, type TurnTier } from "@/lib/types/turn";
import { PHASE_A_BUDGET_MS, RUNG_OVERRUN } from "./degrade";

/**
 * The Pacer (blueprint §7.2, C7): the per-turn beat director, carried whole
 * from v3's pacing discipline (reference/aidm_v3/prompts/pacing.md). One
 * timeboxed probe classifies the beat and PROPOSES a strength; the model is
 * never trusted with the hard core. Code enforces v3's stall table:
 * `override` is admitted ONLY when a phase-gate threshold is met (axiom 3),
 * demoted when the model overreaches, and RAISED to the gate floor when the
 * arc is stalling. The Pacer suggests phase transitions; the Director
 * disposes — a transition is returned, never applied to state.
 *
 * Timeboxed exactly as C4's micro-check: a slow Pacer never stalls Phase A —
 * the turn proceeds without a directive and the degrade ladder logs it.
 */

/**
 * The Pacer's timebox — MODEL-KEYED (M3R2 C5, the measured repair).
 *
 * The old flat 6,000 ms was authored against a Haiku probe and was
 * STRUCTURALLY unsatisfiable on any reasoning model: on the player's live
 * campaign (probe = Sonnet 5) every one of seven pacer_micro traces ran
 * 7.5-25.7 s (Langfuse, campaign 86135b1f, turns 1-6), so the race lost 7/7
 * and `pacer_beat` was NULL on every live turn — the per-scene continuity
 * channel dark since the campaign began, while the call was billed in full.
 * Haiku itself measured 1.4-13.0 s across 23 traces (p50 ~3.5 s), so even the
 * fast tier lost roughly one beat in five.
 *
 * The timebox is a RUNAWAY guard, never a latency dial (§5.5: the ladder
 * catches waste, never deliberate depth). It costs the turn nothing to wait:
 * the Pacer runs inside the Phase-A fan-out beside retrieval, canon and
 * ingestion — on the same live turns those members ran 26-47 s, so the Pacer
 * has never been the critical path. What the old number bought was a discarded
 * result we had already paid for.
 *
 * A reasoning probe (Sonnet/Opus — `effortControl`, the honest discriminator
 * from tiers.ts) asks for 30 s, past the measured 25.7 s worst case; a
 * non-reasoning probe (Haiku) asks for 15 s, past its measured 13.0 s worst
 * case. Both are what the MODEL needs; what the turn can afford is
 * {@link PACER_TIMEBOX_CAP_MS}, and the smaller number wins.
 */
export const PACER_TIMEBOX_MS = 15_000;
export const PACER_TIMEBOX_THINKING_MS = 30_000;

/** The tiers that actually consult the Pacer — §5.1's douga row has none. */
const PACER_TIERS = (Object.keys(TURN_CONTRACTS) as TurnTier[]).filter((t) =>
  TURN_CONTRACTS[t].consultants.includes("pacer"),
);
const TIGHTEST_PACER_BUDGET_MS = Math.min(
  ...PACER_TIERS.map((t) => PHASE_A_BUDGET_MS[t] ?? Number.POSITIVE_INFINITY),
);

/**
 * THE LADDER CEILING on that timebox (M3R3 close).
 *
 * The two numbers above are what the probe MODEL needs; this is what the turn
 * can AFFORD to give it, and the smaller of the two wins. The Pacer runs
 * inside the Phase-A fan-out, and the degrade ladder measures that same wall
 * clock — re-checked (layout.ts `applyLadder`) after every serial stage that
 * follows the fan-out: the relevance filter, the outcome judgment, validation,
 * scale. So a slow Pacer does not merely sit beside its peers; whenever it is
 * the last fan-out member to resolve, its whole box is carried into every
 * later reading. Past `cap_research_2` the ladder cuts the KA's Phase-B
 * research to 2 calls and past `cap_research_0` to none (ka.ts) — the Pacer
 * would be buying its beat with the writer's research, §5.5 exactly inverted.
 * The beat is a nicety; the research is the substance.
 *
 * So the box is capped at the slack the ladder leaves between "on budget"
 * (`skip_validation_retry`, ×1.0) and the FIRST research-capping rung
 * (`cap_research_2`, ×1.4), on the tightest Phase-A budget of any tier that
 * consults the Pacer (genga, 35 s):
 *
 *   35_000 ms × (1.4 − 1.0) = 14_000 ms
 *
 * Read it as the guarantee it is: a Phase A otherwise exactly on budget can
 * absorb the entire Pacer box and still not reach the rung — the Pacer ALONE
 * can never cost the KA a research call. Every term is read from degrade.ts
 * and the §5.1 contract table, so retuning a budget or a rung retunes this;
 * nothing here is a hand-picked number.
 *
 * The cost is honest and accepted: a reasoning probe's measured worst case
 * (25.7 s live) no longer fits, so some Sonnet beats will time out — logged,
 * beat absent, scene proceeds. That is the §5.5 trade in the right direction.
 */
export const PACER_TIMEBOX_CAP_MS = Math.round(
  TIGHTEST_PACER_BUDGET_MS * (RUNG_OVERRUN.cap_research_2 - RUNG_OVERRUN.skip_validation_retry),
);

/** The timebox this probe model can actually meet, under the ladder ceiling. */
export function pacerTimeboxFor(probeModel: string): number {
  const caps = MODEL_CAPS[probeModel];
  const box =
    caps && (caps.adaptiveThinking || caps.effortControl)
      ? PACER_TIMEBOX_THINKING_MS
      : PACER_TIMEBOX_MS;
  return Math.min(box, PACER_TIMEBOX_CAP_MS);
}

type Strength = "suggestion" | "strong" | "override";
const STRENGTH_RANK: Record<Strength, number> = { suggestion: 0, strong: 1, override: 2 };

/**
 * Beat-shape variety (§7.2, §5.3, M2-C8 — the live watch item: both live turns
 * ran the same shape end to end). The beat_classification is a freeform string,
 * but the golden fixtures carry it as `<shape>_<flavor>` (`climax_silent_pressure`,
 * `setup_ritual_grounding`), and the shape prefix draws from the {@link PACER_PHASES}
 * vocabulary — the only enum the classification is built on. So "share one
 * classification" means: the last three completed turns all lead with the same
 * shape token. Detection normalizes to that token (which also catches a rut whose
 * flavors differ but whose shape is stuck).
 */
export function beatShapeToken(classification: string): string {
  // Live classifications are freeform (the probe's string, no enum) — skip
  // leading articles so "the reckoning"/"the calm"/"the chase" never read as
  // one rut on the shared token "the" (C8 audit #3).
  const words = classification
    .trim()
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter((w) => !["the", "a", "an"].includes(w));
  return words[0] || classification.trim().toLowerCase();
}

/** The shape shared by the last 3 completed beats, or undefined (varied, or < 3). */
export function repeatedBeatShape(recentBeats: string[]): string | undefined {
  if (recentBeats.length < 3) return undefined;
  const shapes = recentBeats.slice(-3).map(beatShapeToken);
  const first = shapes[0];
  return first && shapes.every((s) => s === first) ? first : undefined;
}

/**
 * Two contrasting shapes from the vocabulary, excluding the rut — walked from
 * just past the repeated shape in the phase cycle so the picks contrast with it
 * (`climax` → `falling, resolution`). A non-vocabulary rut falls back to the
 * cycle's head.
 */
export function beatShapeAlternatives(shape: string): [string, string] {
  const vocab = PACER_PHASES;
  const idx = vocab.indexOf(shape as (typeof vocab)[number]);
  const ordered = idx >= 0 ? [...vocab.slice(idx + 1), ...vocab.slice(0, idx)] : [...vocab];
  const picked = ordered.filter((p) => p !== shape).slice(0, 2);
  return [picked[0] ?? vocab[0], picked[1] ?? vocab[1]];
}

export interface PacerResult {
  beat?: PacerBeat;
  /** Assembled from the model note + any clamp/gate/tension annotations. */
  pacingNote?: string;
  /** Target phase suggested this turn (model or tension rule). Recorded as an
   *  arc event by the integrator — never applied to state (§7 pacer suggests,
   *  director disposes). */
  phaseTransition?: string;
  timedOut: boolean;
}
// §3's "escalation beats run ≥ high" guard moved to triage (C9): the tier
// floor fires on the arc's escalation/climax phase BEFORE routing, where a
// low-effort turn can actually be prevented. The old promoteEffort output
// here was unsatisfiable — douga never consulted the Pacer, and every
// consulted tier already runs ≥ high.

export interface PacerInput {
  /** Rendered intent line (e.g. "COMBAT, epicness 0.70"). */
  intent: string;
  playerInput: string;
  recentBeats: string[];
  /** Null until a Director has run — beat classification only, strength held at suggestion. */
  arcState: PacerArcState | null;
  /** §7.2 "canonicality-aware" (v3 pacing rule #10, restored M2R R2). The cast
   *  mode joined at M3R3 C4a: the Pacer weighs cast-introduction pacing and was
   *  blind to the one axis that constrains WHO may be introduced. */
  canonicality?: { timeline_mode: string; canon_cast_mode: string; event_fidelity: string };
  campaignId?: string;
  turnNumber?: number;
}

/**
 * v3's stall table, code-side (axiom 3 — override is hard core, granted only
 * on a gate threshold; never trusted to the model). `turnsInPhase` strictly
 * greater than the threshold admits the floor. Falling/resolution carry no
 * override row, so they never reach the override floor.
 */
export function stallDirective(arcState: PacerArcState): { floor: Strength; action?: string } {
  const gate = PHASE_GATES[arcState.phase];
  const turns = arcState.turnsInPhase;
  if (gate.overrideAfter !== undefined && turns > gate.overrideAfter) {
    return { floor: "override", action: gate.overrideAction };
  }
  if (turns > gate.strongAfter) {
    return { floor: "strong", action: gate.strongAction };
  }
  return { floor: "suggestion" };
}

function normalizeStrength(value: unknown): Strength {
  return value === "override" || value === "strong" || value === "suggestion"
    ? value
    : "suggestion";
}

export function buildPrompt(input: PacerInput): string {
  const lines: string[] = [];
  const arc = input.arcState;
  if (arc) {
    const gate = PHASE_GATES[arc.phase];
    const band = ESCALATION_BANDS[arc.phase];
    lines.push(`PHASE: ${arc.phase} (turns in phase: ${arc.turnsInPhase})`);
    lines.push(`TENSION: ${arc.tensionLevel.toFixed(2)}`);
    lines.push(`TARGET BAND (this phase): ${band.min.toFixed(1)}–${band.max.toFixed(1)}`);
    const gateParts = [`> ${gate.strongAfter} turns → strong: "${gate.strongAction}"`];
    if (gate.overrideAfter !== undefined && gate.overrideAction) {
      gateParts.push(`> ${gate.overrideAfter} turns → override: "${gate.overrideAction}"`);
    }
    lines.push(`STALL GATE: ${gateParts.join("; ")}`);
    if (arc.arcName || arc.shape) {
      const name = arc.arcName ? `"${arc.arcName}"` : "(unnamed)";
      lines.push(`ARC: ${name}${arc.shape ? ` (shape: ${arc.shape})` : ""}`);
    }
  } else {
    lines.push("PHASE: none yet (no Director has run) — classify the beat and tone only.");
  }
  if (input.canonicality) {
    lines.push(
      `CANONICALITY: timeline ${input.canonicality.timeline_mode}, cast ${input.canonicality.canon_cast_mode}, events ${input.canonicality.event_fidelity}`,
    );
  }
  if (input.recentBeats.length > 0) lines.push(`RECENT BEATS: ${input.recentBeats.join(" → ")}`);
  lines.push(`PLAYER INPUT: ${input.playerInput}`);
  lines.push(`INTENT: ${input.intent}`);
  return lines.join("\n");
}

export function buildSystem(hasArcState: boolean): string {
  return [
    "You are the Pacer for an anime TTRPG narrative engine — the per-turn beat director (blueprint §7.2).",
    "Classify the beat this action opens and shape it for the writer. Rules, carried from v3's pacing discipline:",
    "- escalation_target: a short target inside this phase's TARGET BAND (a number or a tight range).",
    "- tone: match the beat AND the player's intent.",
    "- must_reference: only elements that are NARRATIVELY DUE — concrete and few; never force a reference.",
    "- avoid: only what would break pacing; concrete and few.",
    "- foreshadowing_hint: one optional seed to plant, when the beat invites it.",
    "- pacing_note: one actionable sentence. When the beat wants a driving close, NAME the concrete pressure this scene should END on (an arrival, a discovery landing, a clock advancing) — vary it turn to turn, grounded in what is live; never re-pose the standing fork the recent beats already posed. When the beat is a breather, say so plainly.",
    "- Defer to active player momentum: if the player is driving the story somewhere, go with them — gates prevent STALLING, never player agency (§7.4: expressed player word > premise-truth > the engine's inferred impulse).",
    "- strength is a PROPOSAL (suggestion/strong/override). The engine enforces the stall table; propose override ONLY when the phase gate's override threshold is met. When in doubt, suggestion.",
    "- CANONICALITY shapes pacing (v3 rule #10): canon_adjacent timeline + observable events → the external canon timeline provides structure; lean on upcoming canon events as natural escalation anchors. alternate timeline or influenceable events → the timeline is mutable; pacing is fully player-driven. inspired timeline or background events → no external timeline exists; pacing rests entirely on player action and Director planning. The CAST mode constrains WHO may be introduced: full_cast → the source's people are this story's people, so pace introductions through them and treat a brand-new named face as a deliberate act; replaced_protagonist → the lead's seat is the player's, never a canon character's; npcs_only → canon supplies supporting cast, never the lead — and on an inspired timeline canon supplies no one at all, so every new face is this story's own and introducing them is the premise working.",
    "- phase_transition: name the target phase ONLY when a transition is genuinely due; otherwise omit.",
    hasArcState
      ? ""
      : "No arc state exists yet: keep strength at suggestion and omit phase_transition.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The full Pacer (§7.2). One timeboxed probe; the model proposes, the code
 * enforces. Returns a conte-ready {@link PacerBeat} with a clamped strength,
 * plus the (never-applied) phase-transition suggestion (effort promotion retired — C9, then §3 flat-high).
 */
export async function runPacer(
  selection: TierSelection,
  input: PacerInput,
  timeboxMs = pacerTimeboxFor(selection.probe),
): Promise<PacerResult> {
  const arc = input.arcState;

  const call = callProbe(selection, {
    // Trace name kept as "pacer_micro" through the C7 migration so the layout
    // integration mocks keep matching; the integrator renames on cut-over.
    name: "pacer_micro",
    schema: PacerDirective,
    campaignId: input.campaignId,
    turnNumber: input.turnNumber,
    system: buildSystem(arc !== null),
    prompt: buildPrompt(input),
    maxTokens: STRUCTURED_SMALL,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeboxMs);
  });
  // A rejected probe is treated like a timeout: no directive, the turn proceeds.
  // The rejection is LOGGED, not swallowed silently (C5): a throwing Pacer and
  // a slow one produced the same invisible null, which is why the live outage
  // had to be diagnosed from the trace store instead of the logs.
  const started = Date.now();
  const directive = await Promise.race([
    call.catch((err) => {
      console.warn(`[pacer] probe failed (turn ${input.turnNumber ?? "?"}) — no beat this scene`, {
        model: selection.probe,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  if (!directive) {
    console.warn(
      `[pacer] no beat (turn ${input.turnNumber ?? "?"}) — the continuity channel is dark`,
      {
        model: selection.probe,
        timeboxMs,
        waitedMs: Date.now() - started,
      },
    );
    return { timedOut: true };
  }

  const notes: string[] = [];
  if (directive.pacing_note) notes.push(directive.pacing_note);
  const mustReference: string[] = [...(directive.must_reference ?? [])];

  // --- Strength: model proposes, the stall table disposes (axiom 3) ---------
  const proposed = normalizeStrength(directive.strength);
  let strength: Strength = "suggestion";
  let phaseTransition: string | undefined;

  if (arc) {
    strength = proposed;
    const gate = stallDirective(arc);

    // Clamp DOWN: override is admitted ONLY on the gate's override threshold.
    if (strength === "override" && gate.floor !== "override") {
      strength = "strong";
      notes.push("override demoted to strong — stall-table threshold not met (axiom 3)");
    }
    // Raise UP: a stalling arc pulls strength to the gate floor.
    if (STRENGTH_RANK[gate.floor] > STRENGTH_RANK[strength]) {
      strength = gate.floor;
    }
    // The table drives the nudge (v3) WHENEVER the arc is stalling — not only
    // when strength had to be raised. Keying the action on the raise direction
    // made v3's corrective text depend on the model's strength proposal
    // instead of on the stall itself (C7 audit).
    if (gate.floor !== "suggestion" && gate.action) {
      notes.push(`phase gate: ${gate.action}`);
      if (!mustReference.includes(gate.action)) mustReference.push(gate.action);
    }

    // Model's transition suggestion (never applied to state; a no-op self-
    // transition is dropped).
    if (directive.phase_transition && directive.phase_transition !== arc.phase) {
      phaseTransition = directive.phase_transition;
    }

    // v3 rule: high tension outside climax forces at least "strong" + a climax
    // suggestion — overrides any model transition.
    if (arc.tensionLevel > TENSION_CLIMAX_SUGGEST && arc.phase !== "climax") {
      if (STRENGTH_RANK[strength] < STRENGTH_RANK.strong) strength = "strong";
      phaseTransition = "climax";
      notes.push(
        `tension ${arc.tensionLevel.toFixed(2)} exceeds ${TENSION_CLIMAX_SUGGEST} outside climax — climax suggested`,
      );
    }
  } else if (proposed !== "suggestion") {
    // Null arc state: no Director has run — strength held at suggestion.
    notes.push("no arc state yet — strength held at suggestion");
  }

  // Beat-shape variety (§7.2/§5.3): three same-shape scenes running earns an
  // ADVISORY nudge on the beat's `avoid` channel (the pacing anti-pattern list
  // the KA reads in the conte). Independent of arc state and strength — variety
  // is craft pressure, never the hard core (axiom 3), so it never elevates
  // strength; it only ever appends to `avoid`.
  const avoid = [...(directive.avoid ?? [])];
  const rut = repeatedBeatShape(input.recentBeats);
  if (rut) {
    // Vocabulary ruts get contrasting named alternatives; a freeform rut
    // (the normal live case) gets the honest generic nudge — fake phase-name
    // alternatives for a scene-shape rut mislead (C8 audit #3).
    const inVocab = (PACER_PHASES as readonly string[]).includes(rut);
    if (inVocab) {
      const [alt1, alt2] = beatShapeAlternatives(rut);
      avoid.push(
        `the last three scenes all landed as ${rut} — vary the shape: consider ${alt1} or ${alt2}`,
      );
    } else {
      avoid.push(
        `the last three scenes all landed the same way (${rut}) — vary the scene's shape this turn`,
      );
    }
    notes.push(`beat-shape variety: three ${rut} scenes running — advised variety`);
  }

  const beat: PacerBeat = {
    beat_classification: directive.beat_classification,
    escalation_target: directive.escalation_target,
    tone: directive.tone,
    must_reference: mustReference,
    avoid,
    foreshadowing_hint: directive.foreshadowing_hint,
    strength,
    // The RAW model note only (M2R2 audit): the joined pacingNote below
    // carries engine strength-bookkeeping, which must never reach the
    // writer's Drive line — gate actions already ride must_reference.
    ...(directive.pacing_note ? { pacing_note: directive.pacing_note } : {}),
  };

  return {
    beat,
    pacingNote: notes.length > 0 ? notes.join(" · ") : undefined,
    phaseTransition,
    timedOut: false,
  };
}
