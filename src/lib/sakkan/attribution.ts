import { CLASSIFY } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { AttributionResult } from "@/lib/types/direction";

/**
 * The gate-trip attribution read (blueprint §4.5 M2R3): when a drift retake
 * trips, one judgment-tier probe asks a SECOND question the blind scorer never
 * can — who is driving this divergence? The Sakkan's SCORING stays blind to the
 * dials (a judge who knows the target scores toward it, §4.5); attribution
 * keeps that blindness and gains sight only of the PLAYER.
 *
 * Blind-protocol invariant (mirrors sakkan/score.ts): the prompt carries the
 * drifting axis, its DIRECTION of drift (higher/lower — a word, never a value),
 * the window's PLAYER INPUTS, and short narration tails for context. It carries
 * NO premise / dial / target / effective value. The AttributionInput type is
 * the type-level guard — it exposes no channel for one; the prompt-spec pin in
 * attribution.test.ts asserts the built prompt does not leak the story's
 * intended values, the way the INTENT_SYSTEM pins do for the scorer.
 *
 * Fires ONCE per gate trip (not per sample) and only on gate trips — cheap by
 * construction (the soak showed trips are rare). Judgment tier, CLASSIFY budget
 * (a small verdict object, like the gauge/router classifiers).
 */

/** Which way the story ran relative to where it framed itself — a word, not a value. */
export type DriftDirection = "higher" | "lower";

/**
 * The probe's ONLY inputs. No `wanted`/`target`/`active`/`premise` channel
 * exists here by design — the blindness is enforced at the type level, so a
 * dial cannot be smuggled into the prompt (attribution.test.ts pins the key
 * set the way score.test.ts pins ScoreOptions).
 */
export interface AttributionInput {
  axis: string;
  direction: DriftDirection;
  /** The window's player inputs, oldest→newest — the evidence the read weighs. */
  playerInputs: string[];
  /** Short narration tails, oldest→newest — context only, never the whole scene. */
  narrationTails: string[];
}

export const ATTRIBUTION_SYSTEM = [
  "You are the Sakkan's attribution read for a prose story engine. The drift band",
  "has already flagged that one tonal axis is running away from the register the",
  "story set out with — you are NOT asked to re-measure it, and you are never told",
  "where the story was aiming. Your ONE job: decide WHO is driving the divergence.",
  "You are given the axis, which DIRECTION it drifted (higher or lower), the",
  "player's own inputs across the window, and short tails of what the writer wrote.",
  "Weigh the PLAYER INPUTS first: if the player keeps steering the story this way",
  "turn after turn, the driver is the player (player_driven). If the writer wandered",
  "off on its own while the player's inputs did not ask for it, the driver is the",
  "narrator (narrator_driven). If both are pulling together, say entangled. Give one",
  "evidence sentence grounded in the player inputs.",
].join(" ");

function clipTail(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const tail = flat.slice(-max);
  const firstSpace = tail.indexOf(" ");
  return `…${firstSpace > 0 ? tail.slice(firstSpace + 1) : tail}`;
}

/**
 * Build the attribution prompt — pure, and blind by construction: it can only
 * render what AttributionInput carries, and AttributionInput carries no dial.
 */
export function buildAttributionPrompt(input: AttributionInput): string {
  const inputs =
    input.playerInputs.length > 0
      ? input.playerInputs.map((t, i) => `  ${i + 1}. ${t.replace(/\s+/g, " ").trim()}`).join("\n")
      : "  (no player inputs in this window)";
  const tails =
    input.narrationTails.length > 0
      ? input.narrationTails.map((t) => `  - …${clipTail(t)}`).join("\n")
      : "  (none)";
  return [
    `Drifting axis: ${input.axis}`,
    `Direction of drift: the story is reading ${input.direction} on this axis than the register it set out with.`,
    "",
    "PLAYER INPUTS across the window (oldest first — weigh these first):",
    inputs,
    "",
    "Narration tails (context only):",
    tails,
    "",
    "Classify the driver (player_driven | narrator_driven | entangled) with one evidence sentence from the player inputs.",
  ].join("\n");
}

/** Run the blind gate-trip attribution read through the traced trio (judgment tier). */
export async function attributeDrift(
  selection: TierSelection,
  input: AttributionInput & { campaignId?: string; turnNumber?: number },
): Promise<AttributionResult> {
  return callJudgment(selection, {
    name: "sakkan_attribution",
    schema: AttributionResult,
    system: ATTRIBUTION_SYSTEM,
    prompt: buildAttributionPrompt(input),
    effort: "low",
    maxTokens: CLASSIFY,
    campaignId: input.campaignId,
    turnNumber: input.turnNumber,
  });
}
