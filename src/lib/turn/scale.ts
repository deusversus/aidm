import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import type { IntentOutput } from "@/lib/types/turn";
import { z } from "zod";
import {
  CONTEXT_MODIFIER_KINDS,
  NARRATIVE_SCALES,
  type NarrativeScale,
  SCALE_COMPATIBILITY,
  imbalanceBand,
  imbalanceFlags,
  rawPowerRatio,
  tierBand,
} from "./power";

/**
 * Scale/imbalance selector (§5.1 sakuga consultant; v3 Module 12 carried):
 * Effective = (PC raw × context) ÷ threat raw. Context modifiers suppress
 * effective power (a secret identity held, a mentor's restraint, political
 * cost) — the fight a character COULD win at a walk still plays tense when
 * the context says they're fighting with one hand.
 *
 * v3 skipped the model call on same-tier fights, but its threat tier came
 * in via outcome.target_tier — a field the M0-frozen OutcomeOutput doesn't
 * carry, so the threat estimate arrives WITH this call and no pre-call
 * skip is possible. Revisit at M2 if the contract grows target_tier.
 */

const ScaleJudgment = z.object({
  /** 0.1–1.0 multiplier per detected context suppressor; omit undetected kinds.
   *  kind is a STRING in the model-facing schema, filtered to
   *  CONTEXT_MODIFIER_KINDS in code (M1 soak: the API's strict output let an
   *  out-of-vocabulary kind through and the zod enum killed the hard-core
   *  combat call — model proposes, code disposes; an unknown kind drops with
   *  a warn, never a failed turn). */
  context_modifiers: z
    .array(
      z.object({
        kind: z.string(),
        multiplier: z.number().min(0.1).max(1),
        reason: z.string(),
      }),
    )
    .default([]),
  /** The scale this beat should play at (compatibility-checked in code). */
  primary_scale: z.enum(NARRATIVE_SCALES),
  secondary_scale: z.enum(NARRATIVE_SCALES).optional(),
  threat_tier: z.number().int().min(0).max(11),
  rationale: z.string(),
});

export interface ScaleResult {
  primaryScale: NarrativeScale;
  secondaryScale?: NarrativeScale;
  effectiveRatio: number;
  band: ReturnType<typeof imbalanceBand>;
  triggersOpMode: boolean;
  triggersTensionShift: boolean;
  contextModifiers: { kind: string; multiplier: number; reason: string }[];
  /** Prose line for the conte's combat pre-resolution. */
  directive: string;
}

export async function judgeScale(
  selection: TierSelection,
  args: {
    intent: IntentOutput;
    playerInput: string;
    characterTier: number;
    worldBaselineTier: number;
    memories: string[];
    campaignId: string;
    turnNumber: number;
  },
): Promise<ScaleResult> {
  const judged = await callJudgment(selection, {
    name: "scale_imbalance",
    schema: ScaleJudgment,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    system: [
      "You are the scale selector (Module 12): pick the narrative scale a",
      "combat beat plays at and detect CONTEXT MODIFIERS that suppress the",
      "character's effective power (multipliers 0.1-1.0): environmental",
      "(terrain/conditions), secret_id (holding back to protect an identity),",
      "self_limiter (vows, seals, restraint), mentor (teaching, not winning),",
      "political (a win here costs standing), genre (the story's register",
      "caps the flex). Only report modifiers the situation actually shows.",
      "Estimate the threat's power tier (T10 ordinary human … T1 boundless;",
      "lower = stronger). Scales: tactical (every move matters), ensemble,",
      "spectacle, existential, underdog, slice_of_life, horror, mystery,",
      "comedy.",
    ].join(" "),
    prompt: [
      `COMBAT BEAT: ${args.playerInput}`,
      `CHARACTER TIER: T${args.characterTier} (${tierBand(args.characterTier)}). World baseline: T${args.worldBaselineTier}.`,
      args.memories.length > 0 ? `CONTEXT:\n${args.memories.map((m) => `- ${m}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    effort: "high",
    maxTokens: 4_000,
  });

  // The closed Module-12 vocabulary is enforced HERE (not by parse-rejection):
  // unknown kinds drop with a warn; multipliers clamp into [0.1, 1] as belt
  // (numeric ranges are another constraint the output grammar can't carry).
  const modifiers = judged.context_modifiers
    .filter((m) => {
      const known = (CONTEXT_MODIFIER_KINDS as readonly string[]).includes(m.kind);
      if (!known) {
        console.warn(`[scale] dropped unknown context modifier kind "${m.kind}" (Module 12)`);
      }
      return known;
    })
    .map((m) => ({ ...m, multiplier: Math.min(1, Math.max(0.1, m.multiplier)) }));

  const contextProduct = modifiers.reduce((p, m) => p * m.multiplier, 1);
  const effectiveRatio = rawPowerRatio(args.characterTier, judged.threat_tier) * contextProduct;
  const band = imbalanceBand(effectiveRatio);
  const flags = imbalanceFlags(effectiveRatio);

  // Compatibility check is CODE: a forbidden scale for the tier band demotes
  // to the first OK scale rather than trusting the judge blindly.
  const bandKey = tierBand(args.characterTier);
  let primaryScale = judged.primary_scale;
  if (SCALE_COMPATIBILITY[bandKey][primaryScale] === "FORBIDDEN") {
    const fallback = NARRATIVE_SCALES.find((s) => SCALE_COMPATIBILITY[bandKey][s] === "OK");
    primaryScale = fallback ?? "ensemble";
  }

  const directive = [
    `Scale: ${primaryScale}${judged.secondary_scale ? ` (secondary: ${judged.secondary_scale})` : ""}.`,
    `Power imbalance: ${band} (effective ${effectiveRatio.toFixed(1)}×).`,
    flags.triggersOpMode
      ? "OP framing: the outcome is not in question — the interest is HOW, and what it costs everyone watching."
      : flags.triggersTensionShift
        ? "Tension shifts off raw victory: stakes live in collateral, speed, and what the win exposes."
        : "Evenly matched: every exchange matters; spend the choreography budget.",
    ...modifiers.map((m) => `Context: ${m.kind} ×${m.multiplier} — ${m.reason}`),
  ].join(" ");

  return {
    primaryScale,
    secondaryScale: judged.secondary_scale,
    effectiveRatio,
    band,
    ...flags,
    contextModifiers: modifiers,
    directive,
  };
}
