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

/**
 * power_expression's consumer (M2R R2 — the SV3 choice had zero readers).
 * Compact distillations of rule_library/composition/power_expression.yaml,
 * which remains the library source; "balanced" is the default register and
 * renders nothing.
 */
const POWER_LINE: Partial<Record<Composition["power_expression"], string>> = {
  instantaneous:
    "one action ends it — spend the page on the moment before and the reaction after, not the strike",
  overwhelming: "victory is assumed; dwell on the slow certainty and the helplessness facing it",
  sealed: "the power is held back — tension lives in the seal straining, the crack widening",
  hidden: "capability concealed — lean on dramatic irony; others underestimate, the reader knows",
  conditional:
    "power waits on its trigger — the chant, the blood, the moment of resolve; tension lives in the build toward it",
  derivative:
    "power moves through others — subordinates and systems act; the will behind them is the character",
  passive: "presence alone bends the room — no exertion, just effect",
  flashy: "stylish, kinetic power on full display — the craft is in the choreography",
};

export function renderSceneShape(framing: Composition, arc: ArcShapeState = {}) {
  const lines: string[] = ["## Scene shape"];
  lines.push(`Focus: ${FOCUS_LINE[framing.narrative_focus]}. Player role: ${framing.player_role}.`);
  lines.push(
    `Opposition on screen: ${framing.antagonist_origin} / ${framing.antagonist_multiplicity}. Tension source: ${framing.tension_source}.`,
  );
  lines.push(`Choice weight: ${WEIGHT_LINE[framing.choice_weight]}.`);
  const powerLine =
    framing.mode === "not_applicable" ? undefined : POWER_LINE[framing.power_expression];
  if (powerLine) lines.push(`Power on screen: ${powerLine}.`);
  if (arc.arcName && arc.phase) {
    // The trajectory note is model-authored and unbounded upstream; clamp it
    // here so the ≤150-token budget the constant promises actually holds.
    const note = arc.trajectoryNote
      ? arc.trajectoryNote.length > 200
        ? `${arc.trajectoryNote.slice(0, 200).trimEnd()}…`
        : arc.trajectoryNote
      : undefined;
    lines.push(`Arc "${arc.arcName}" (${arc.phase})${note ? `: ${note}` : "."}`);
  }
  const text = lines.join("\n");
  return { text, tokens: approxTokens(text) };
}
