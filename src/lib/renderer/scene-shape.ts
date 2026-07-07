import { approxTokens } from "@/lib/blocks/tokens";
import type { Composition } from "@/lib/types/composition";

/**
 * Scene-Shape Directives (§4.4c): Framing's consumer path — ≤150 tokens of
 * per-scene shape guidance rendered on Director cadence into the conte.
 * Framing enums don't delta, so this channel is qualitative by design; the
 * Director's dailies judge adherence (§4.4c), not the numeric Sakkan.
 */

export const SCENE_SHAPE_TOKEN_MAX = 150;

/** Arc-state fields the Director supplies (C7); typed thin until then. */
export interface ArcShapeState {
  arcName?: string;
  phase?: string;
  /** What this arc's trajectory demands of this beat, in the Director's words. */
  trajectoryNote?: string;
}

const FOCUS_LINE: Record<Composition["narrative_focus"], string> = {
  internal: "camera close on the protagonist's own arc",
  ensemble: "spread the scene across the crew — someone besides the lead gets a beat",
  reverse_ensemble: "frame from the POV of those facing the protagonist",
  episodic: "this scene serves the standalone story of the week",
  faction: "the organization is the character; individuals speak for it",
  mundane: "the ordinary is the point — resist escalation",
  competition: "rank and rivalry structure every interaction",
  legacy: "the next generation is watching; frame teaching moments",
  party: "balanced adventuring beats — everyone contributes their craft",
};

const WEIGHT_LINE: Record<Composition["choice_weight"], string> = {
  world_shaping: "choices here ripple to factions and future arcs — make weight visible",
  local: "choices land on this scene and these relationships",
  flavor: "choices color the telling, not the outcome",
};

export function renderSceneShape(framing: Composition, arc: ArcShapeState = {}) {
  const lines: string[] = ["## Scene shape"];
  lines.push(`Focus: ${FOCUS_LINE[framing.narrative_focus]}. Player role: ${framing.player_role}.`);
  lines.push(
    `Opposition on screen: ${framing.antagonist_origin} / ${framing.antagonist_multiplicity}. Tension source: ${framing.tension_source}.`,
  );
  lines.push(`Choice weight: ${WEIGHT_LINE[framing.choice_weight]}.`);
  if (arc.arcName && arc.phase) {
    lines.push(
      `Arc "${arc.arcName}" (${arc.phase})${arc.trajectoryNote ? `: ${arc.trajectoryNote}` : "."}`,
    );
  }
  const text = lines.join("\n");
  return { text, tokens: approxTokens(text) };
}
