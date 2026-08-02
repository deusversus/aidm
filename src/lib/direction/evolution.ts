import type { Db } from "@/lib/db";
import { campaigns, criticalFacts } from "@/lib/db/schema";
import { ArcOverride } from "@/lib/types/arc";
import {
  DIRECTOR_CAPS,
  DirectionState,
  EVOLUTION_AXIS_DELTA,
  EVOLUTION_CATEGORY,
  EVOLUTION_MIN_AXES,
  EVOLUTION_SUSTAINED_SAMPLES,
  type EvolutionAxisShift,
  type EvolutionProposal,
  type SakkanActiveNote,
  type SakkanState,
} from "@/lib/types/direction";
import type { DNAScales } from "@/lib/types/dna";
import { PremiseContract } from "@/lib/types/premise";
import { and, eq, sql } from "drizzle-orm";
import { type SeasonBoundary, seasonBoundary } from "./arcs";

/**
 * Evolution ratification (blueprint §7.1, M3 C4): "when the trend shows the
 * story becoming something better than its premise, the Director raises it
 * with the player — at season boundaries only, only when the delta is
 * sustained and material, in the fiction's own language. Player-ratified
 * evolution amends the active premise and the bible like a retooling between
 * seasons; unratified drift gets pulled home. Never an anxious check-in."
 *
 * The reconciliation this module encodes (M3 C4): M2R3's steering NOTICE is
 * the IN-SEASON channel and is untouched — any cycle, arc_override only,
 * dismissible, silence is consent, bible untouched. THIS is the season-boundary
 * event: a proposal that amends nothing until the player says the word, and
 * whose two answers are both explicit. They are different mechanisms; they no
 * longer wear one name.
 *
 * The gate is CODE, not the model's mood. No season boundary → no section. No
 * sustained material evidence → no section. The Director cannot raise a
 * retooling it was not handed the evidence for, which is what keeps the rare
 * thing rare.
 */

/** One axis the season's evidence puts on the table. */
export interface EvolutionCandidate {
  axis: string;
  /** The ACTIVE layer's value today — what ratification would overwrite (§4.2). */
  from: number;
  /** The blind Gauge's latest read: where the season actually played. */
  observed: number;
  delta: number;
  /** Consecutive drifting samples behind this reading. */
  samples: number;
  /** The attribution probe's one sentence naming why this is the player's doing. */
  evidence: string;
  since_turn: number;
}

/**
 * The evidence, measured (§4.5 → §7.1). An axis reaches the table only when
 * BOTH instruments agree: the gate-trip attribution charged its drift to the
 * PLAYER (state.sakkan.player_driven — the story is being pulled, not wandering)
 * AND the Gauge's own counter shows the pull sustained across
 * EVOLUTION_SUSTAINED_SAMPLES samples. One reading is a scene; a season is a
 * season. Pure.
 */
export function evolutionCandidates(
  state: DirectionState,
  active: DNAScales,
): EvolutionCandidate[] {
  const findings = Object.values(state.sakkan?.player_driven ?? {});
  const readings = state.sakkan?.readings ?? {};
  const candidates: EvolutionCandidate[] = [];
  for (const finding of findings) {
    const axis = finding.axis;
    if (!(axis in active)) continue;
    const reading = readings[axis];
    if (!reading || reading.consecutive_drift < EVOLUTION_SUSTAINED_SAMPLES) continue;
    const from = active[axis as keyof DNAScales];
    candidates.push({
      axis,
      from,
      observed: finding.observed,
      delta: Math.abs(finding.observed - from),
      samples: reading.consecutive_drift,
      evidence: finding.evidence,
      since_turn: finding.at_turn,
    });
  }
  return candidates.sort((a, b) => b.delta - a.delta);
}

/**
 * Material (§7.1 "only when the delta is sustained and material"): EITHER the
 * season pulled EVOLUTION_MIN_AXES axes player-ward at once (breadth — a story
 * pulled sideways on two axes is not the same story), OR one axis moved
 * EVOLUTION_AXIS_DELTA points or more (depth). Everything else is a mood, and
 * a mood does not earn a question. Pure.
 */
export function materialEvidence(candidates: readonly EvolutionCandidate[]): boolean {
  if (candidates.length >= EVOLUTION_MIN_AXES) return true;
  return candidates.some((c) => c.delta >= EVOLUTION_AXIS_DELTA);
}

/** The open gate: the season boundary that opened it and the axes on the table. */
export interface EvolutionGate {
  season: SeasonBoundary;
  candidates: EvolutionCandidate[];
}

/**
 * The full gate for one Director cycle. Returns null — meaning no EVOLUTION
 * REVIEW section, and therefore no proposal this cycle — when any link is
 * missing: a proposal is already pending (the card is already asking; asking
 * twice is the anxious check-in §7.1 forbids), the season is mid-run, or the
 * evidence is not material.
 */
export async function evolutionGate(
  db: Db,
  campaignId: string,
  state: DirectionState,
  contract: PremiseContract,
  turnNumber: number,
): Promise<EvolutionGate | null> {
  if (state.evolution_proposal) return null;
  const candidates = evolutionCandidates(state, contract.active.treatment);
  if (!materialEvidence(candidates)) return null;
  const season = await seasonBoundary(db, campaignId, turnNumber);
  if (!season) return null;
  // ONE review per season, whatever the answer (C4 audit): a spent season
  // keeps reading "boundary" until succession exists, and a declined
  // proposal must never be re-asked — rarity is the mechanism's spine.
  if (state.last_evolution_review?.season_id === season.seasonId) return null;
  return { season, candidates };
}

/** Integers bare, fractions to one decimal — the dossier reads as prose, not a dump. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The dossier's EVOLUTION REVIEW section (§7.1). Present ONLY behind the gate,
 * which is why the Director may be confident here: by the time it reads this,
 * the evidence already exists. The section says so, and it says the other
 * half too — that declining to propose is the ordinary answer.
 */
export function renderEvolutionReview(gate: EvolutionGate): string {
  const lines = gate.candidates.map(
    (c) =>
      `- ${c.axis}: the season played it ~${fmt(c.observed)}/10 against the premise's ${fmt(c.from)}/10 — sustained ${c.samples} samples, since turn ${c.since_turn}${c.evidence ? ` — "${c.evidence}"` : ""}`,
  );
  return [
    `## EVOLUTION REVIEW — "${gate.season.name}" reaches its boundary (${gate.season.consumed}/${gate.season.target} ${gate.season.reason === "closing" ? "— closing" : "episodes"})`,
    "",
    "A season has run its length and the drift band says the story has been becoming something other than what it framed itself as — the player pulling, not the narration wandering. This is the ONE window where you may ask whether that should become what you are making. It is a season retooling, not a correction: ratified, it amends the ACTIVE premise permanently and is dated into the series bible.",
    "",
    "The evidence, measured:",
    ...lines,
    "",
    `If — and only if — you believe the story is genuinely BETTER as what it has become, emit an evolution_proposal: the axes to move (at most ${DIRECTOR_CAPS.evolution_axes}, drawn ONLY from the list above; anything else is discarded unread) with their destination values, and your case in one paragraph, in the fiction's own language. The player reads that paragraph VERBATIM — write it to them, as the showrunner, not as a report: name what the story has become and say plainly that you think it is better.`,
    "Declining is the ordinary answer, and it costs nothing: omit the field and the season turns without a word. Never ask because a number moved — ask because the story earned it.",
  ].join("\n");
}

/**
 * Build the stored proposal from what the model emitted (M3 C4). The bounds
 * law (C1): the strict-output grammar strips length and range bounds, so the
 * ceilings are applied HERE — axes outside the evidence set are dropped (the
 * gate is the evidence, and a proposal may only move what was measured),
 * destination values clamp to 0–10, and no-op shifts drop. Returns null when
 * nothing survives — a proposal that changes nothing must never raise a card.
 * Pure.
 */
export function buildEvolutionProposal(
  emitted: { director_case: string; axes: Array<{ axis: string; to: number }> } | undefined,
  gate: EvolutionGate,
  turnNumber: number,
): EvolutionProposal | null {
  if (!emitted) return null;
  const directorCase = emitted.director_case.trim();
  if (!directorCase) return null;

  const byAxis = new Map(gate.candidates.map((c) => [c.axis, c]));
  const seen = new Set<string>();
  const axes: EvolutionAxisShift[] = [];
  for (const shift of emitted.axes) {
    if (axes.length >= DIRECTOR_CAPS.evolution_axes) break;
    const candidate = byAxis.get(shift.axis);
    if (!candidate) {
      console.warn(
        `[evolution] proposed axis "${shift.axis}" is outside the season's evidence — dropped`,
      );
      continue;
    }
    if (seen.has(shift.axis)) continue;
    seen.add(shift.axis);
    const to = Math.min(10, Math.max(0, shift.to));
    if (to === candidate.from) continue;
    axes.push({ axis: shift.axis, from: candidate.from, to });
  }
  if (axes.length === 0) return null;

  return {
    season_id: gate.season.seasonId,
    season_name: gate.season.name,
    proposed_at_turn: turnNumber,
    director_case: directorCase,
    axes,
  };
}

// --- The two answers ---------------------------------------------------------

export type EvolutionAnswer = "ratify" | "pull_home";

export type EvolutionResult =
  | { ok: true; axes: EvolutionAxisShift[] }
  | { ok: false; reason: "no_proposal" | "contract_unreadable" };

/** The provenance envelope the ratified amendment and its bible note carry. */
export const RATIFIED_PROVENANCE = "player_ratified";

/**
 * The bible note (§9.1 source material): a dated line plus the Director's case
 * VERBATIM, filed as a critical fact under its own `evolution` category. It
 * rides the layer-9 TABLE for the envelope — provenance, turn anchor, and the
 * rewind's tombstone sweep — but not the layer-9 INJECTION: retrieval.ts
 * excludes the category, because Layout files criticals under the conte's
 * "inviolable" hard constraints, and a paragraph arguing a case is a record,
 * not a rule. Its reader is the Series Bible (bible.ts); its pressure reaches
 * the pen through the amended premise and the Charter rebuilt from it.
 *
 * Deliberately NO axis numbers: numbers are for measurement, prose is for
 * pressure (§4.4), and the player already read the dials on the card.
 */
export function evolutionNote(proposal: EvolutionProposal): string {
  const season = proposal.season_name.trim() || "the season";
  return `${season} — retooling proposed at turn ${proposal.proposed_at_turn} and ratified by the player: ${proposal.director_case.trim()}`;
}

/** Both answers settle the Sakkan for the proposed axes; this composes the subtree. */
function settleSakkan(
  state: DirectionState,
  proposal: EvolutionProposal,
  answer: EvolutionAnswer,
): SakkanState | null {
  const sakkan = state.sakkan;
  if (!sakkan) return null;
  const axes = new Set(proposal.axes.map((a) => a.axis));

  // Either answer ENDS the player-driven exemption on these axes: ratified, the
  // premise moved to meet play and there is no divergence left to excuse;
  // pulled home, the player has said hold the line and the band must be free to
  // strain again (the exemption is what closed the retake in the first place).
  const player_driven = Object.fromEntries(
    Object.entries(sakkan.player_driven).filter(([axis]) => !axes.has(axis)),
  );

  const notes = new Map<string, SakkanActiveNote>();
  for (const note of sakkan.active_notes) notes.set(note.axis, note);
  for (const shift of proposal.axes) {
    if (answer === "ratify") {
      // A retake against a value that is now canon IS the eternal retake.
      notes.delete(shift.axis);
    } else {
      // Pull it home: a retake-strength note per proposed axis, so the drift
      // band's Amendments pull the prose back to the premise the player kept.
      notes.set(shift.axis, {
        axis: shift.axis,
        active: shift.from,
        observed: shift.to,
        since_turn: proposal.proposed_at_turn,
      });
    }
  }

  return { ...sakkan, player_driven, active_notes: [...notes.values()] };
}

/**
 * Answer the card (§7.1). RATIFY amends the ACTIVE premise layer's named axes
 * permanently (§4.2 — the same discipline as an arc_override application, minus
 * the transience), dates the note into the bible, and clears the proposal;
 * PULL HOME clears the proposal and plants retakes so the drift band pulls the
 * prose back. Both are the player's explicit word: silence does neither, which
 * is why nothing here has a timeout.
 *
 * Row-locked (the state is read-modify-write) and surgical: the direction_state
 * write touches only the sakkan subtree and removes one key, so a Director
 * cycle saving mid-answer cannot lose its own fields. The known narrow race is
 * M2R3's, unchanged: a cycle that LOADED state before this answer re-persists
 * the proposal on its whole-object save and the card shows once more. Ratify
 * is idempotent about its bible note for exactly that reason.
 */
export async function answerEvolution(
  db: Db,
  campaignId: string,
  answer: EvolutionAnswer,
): Promise<EvolutionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM ${campaigns} WHERE ${campaigns.id} = ${campaignId} FOR UPDATE`,
    );
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
    if (!campaign) return { ok: false as const, reason: "no_proposal" as const };

    const state = DirectionState.safeParse(campaign.directionState ?? {});
    const proposal = state.success ? state.data.evolution_proposal : undefined;
    if (!state.success || !proposal) {
      return { ok: false as const, reason: "no_proposal" as const };
    }

    const contract = PremiseContract.safeParse(campaign.premiseContract);
    if (answer === "ratify" && !contract.success) {
      // Loudly, never a silent 200: an amendment that cannot be written is not
      // an amendment, and the card must stay up rather than lie (C5 pillar).
      return { ok: false as const, reason: "contract_unreadable" as const };
    }

    const nextSakkan = settleSakkan(state.data, proposal, answer);
    // Surgical jsonb throughout — G2 writes direction_state concurrently, so
    // the answer touches ONLY its own keys: sakkan (maybe), the one-review
    // stamp (both answers — rarity survives the answer), the undo ledger
    // (ratify only, §6.7: the amendment must be revocable), and the proposal.
    const stamp = JSON.stringify({
      season_id: proposal.season_id,
      turn: proposal.proposed_at_turn,
    });
    const historyEntry = JSON.stringify({
      season_id: proposal.season_id,
      turn: proposal.proposed_at_turn,
      axes: proposal.axes.map((a) => ({ axis: a.axis, from: a.from, to: a.to })),
    });
    let directionState = nextSakkan
      ? sql`jsonb_set(coalesce(${campaigns.directionState}, '{}'::jsonb), '{sakkan}', ${JSON.stringify(nextSakkan)}::jsonb)`
      : sql`coalesce(${campaigns.directionState}, '{}'::jsonb)`;
    directionState = sql`jsonb_set(${directionState}, '{last_evolution_review}', ${stamp}::jsonb)`;
    if (answer === "ratify") {
      directionState = sql`jsonb_set(${directionState}, '{evolution_history}', coalesce(${campaigns.directionState}->'evolution_history', '[]'::jsonb) || ${historyEntry}::jsonb)`;
    }
    directionState = sql`${directionState} #- '{evolution_proposal}'`;

    let premiseContract: PremiseContract | undefined;
    let nextArcOverride: ArcOverride | null | undefined;
    if (answer === "ratify" && contract.success) {
      const treatment = { ...contract.data.active.treatment };
      for (const shift of proposal.axes) {
        if (!(shift.axis in treatment)) continue;
        treatment[shift.axis as keyof DNAScales] = shift.to;
      }
      premiseContract = {
        ...contract.data,
        active: { ...contract.data.active, treatment },
      };
      // A live arc_override outranks active in the effective premise (§4.2),
      // so a ratified axis would keep playing at the override's value until
      // its transition signal — while the card said "permanently" (C4 audit).
      // The ratified value IS the new law: the override releases those axes.
      const overrideParse = ArcOverride.safeParse(campaign.arcOverride);
      if (overrideParse.success && overrideParse.data) {
        const dna = { ...overrideParse.data.dna };
        let changed = false;
        for (const shift of proposal.axes) {
          if (shift.axis in dna) {
            delete dna[shift.axis as keyof typeof dna];
            changed = true;
          }
        }
        if (changed) {
          nextArcOverride = Object.keys(dna).length > 0 ? { ...overrideParse.data, dna } : null;
        }
      }
    }

    await tx
      .update(campaigns)
      .set({
        directionState,
        ...(premiseContract ? { premiseContract } : {}),
        ...(nextArcOverride !== undefined ? { arcOverride: nextArcOverride } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    if (answer === "ratify") {
      const content = evolutionNote(proposal);
      // Idempotent against the documented resurrection race — the same
      // retooling must never file twice into the bible.
      const [existing] = await tx
        .select({ id: criticalFacts.id })
        .from(criticalFacts)
        .where(and(eq(criticalFacts.campaignId, campaignId), eq(criticalFacts.content, content)))
        .limit(1);
      if (!existing) {
        await tx.insert(criticalFacts).values({
          campaignId,
          content,
          category: EVOLUTION_CATEGORY,
          turnId: proposal.proposed_at_turn,
          provenance: RATIFIED_PROVENANCE,
          confidence: 1,
        });
      }
    }

    return { ok: true as const, axes: proposal.axes };
  });
}
