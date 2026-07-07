import {
  type IntentOutput,
  TRIAGE_THRESHOLDS,
  TURN_CONTRACTS,
  type TurnContract,
  type TurnTier,
} from "@/lib/types/turn";

/**
 * Triage (blueprint §5.1): the intent probe IS the triage call — this maps
 * its output to the turn contract. Douga: low epicness, none of the
 * routed-work intents, no flags. Sakuga: high epicness, combat, or flags.
 * Genga is the default. Pure code — the thresholds live in types/turn.
 */

const NEVER_DOUGA = new Set(["COMBAT", "SOCIAL", "ABILITY"]);

export function classifyTier(intent: IntentOutput): TurnTier {
  const flagged = intent.special_conditions.length > 0;
  if (
    intent.intent === "COMBAT" ||
    flagged ||
    intent.epicness >= TRIAGE_THRESHOLDS.sakugaMinEpicness
  ) {
    return "sakuga";
  }
  if (intent.epicness < TRIAGE_THRESHOLDS.dougaMaxEpicness && !NEVER_DOUGA.has(intent.intent)) {
    return "douga";
  }
  return "genga";
}

export function contractFor(intent: IntentOutput): TurnContract {
  return TURN_CONTRACTS[classifyTier(intent)];
}

/**
 * §5.4 channels route BEFORE the story pipeline: meta/override/OP-command
 * inputs are not scene turns. C4 exposes the routing decision; the channel
 * responders land C9 (meta booth) and C6 (world assertions run through the
 * story turn's universal ingestion).
 */
export function isChannelInput(intent: IntentOutput): boolean {
  return (
    intent.intent === "META_FEEDBACK" ||
    intent.intent === "OVERRIDE_COMMAND" ||
    intent.intent === "OP_COMMAND"
  );
}
