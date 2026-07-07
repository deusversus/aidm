import { callProbe } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { PacerBeat } from "@/lib/types/conte";
import type { IntentOutput } from "@/lib/types/turn";
import { z } from "zod";

/**
 * The Pacer micro-check (§7.2 thin slice — C4 ships beat classification;
 * the full Pacer with stall tables and phase gates lands C7). Timeboxed:
 * a slow Pacer never stalls Phase A — the turn proceeds without its
 * directive and the ladder logs the timeout.
 */

const PacerProbe = z.object({
  beat_classification: z.string().min(1),
  tone: z.string().optional(),
  /** True when this is a build-up/escalation beat (effort promotion, §3 caveat). */
  escalation: z.boolean().default(false),
});

export const PACER_TIMEBOX_MS = 6_000;

export interface PacerResult {
  beat?: PacerBeat;
  /** Escalation beats run ≥high effort — narratively trivial ≠ functionally trivial. */
  promoteEffort: boolean;
  timedOut: boolean;
}

export async function pacerMicroCheck(
  selection: TierSelection,
  args: {
    intent: IntentOutput;
    playerInput: string;
    recentBeats: string[];
    campaignId: string;
    turnNumber: number;
  },
  timeboxMs = PACER_TIMEBOX_MS,
): Promise<PacerResult> {
  const call = callProbe(selection, {
    name: "pacer_micro",
    schema: PacerProbe,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    system: [
      "You are the Pacer's beat classifier. Name the beat this action opens",
      "(e.g. quiet-before, escalation, confrontation, aftermath, breather,",
      "reveal, travel, bonding) and its tone. Flag escalation=true for",
      "build-up beats that ramp toward a peak — those must never be starved",
      "of craft budget even when they read as small.",
    ].join(" "),
    prompt: [
      `ACTION: ${args.playerInput}`,
      `INTENT: ${args.intent.intent}, epicness ${args.intent.epicness}`,
      args.recentBeats.length > 0 ? `RECENT BEATS: ${args.recentBeats.join(" → ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    maxTokens: 1_000,
  });

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeboxMs));
  const result = await Promise.race([call.then((r) => r).catch(() => null), timeout]);
  if (!result) {
    return { promoteEffort: false, timedOut: true };
  }
  const beat: PacerBeat = PacerBeat.parse({
    beat_classification: result.beat_classification,
    tone: result.tone,
    strength: "suggestion",
  });
  return { beat, promoteEffort: result.escalation, timedOut: false };
}
