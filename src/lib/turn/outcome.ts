import { STRUCTURED_RICH, STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import type { PreResolvedMechanics } from "@/lib/types/conte";
import { type IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type D20Roll, rollD20, successBand, sumModifiers } from "./dice";

/**
 * Outcome judgment (blueprint §5.1; v3 outcome_judge.md carried whole):
 * the CODE rolls the die once; the judge sets DC, names modifiers, weighs
 * the scene, and rules on cost — then the code recomputes the band from
 * the actual arithmetic. The model never rolls; the die never lies.
 */

const OUTCOME_SYSTEM = `You are the Outcome Judge — the game master's mechanical conscience. Determine the success/failure of an action using EXPLICIT MECHANICS (DC and dice) while maintaining ANIME LOGIC.

CORE PRINCIPLES
1. STORY > SIMULATION: the dice serve the story.
2. EARNED VICTORIES: did the player set this up?
3. ANIME LOGIC: "Rule of Cool", "Power of Friendship", and "Dramatic Timing" are actual modifiers.
4. COSTS ARE RARE, NOT DEFAULT: only assign costs/consequences when dramatically appropriate. Routine actions within a character's established capability NEVER have a cost — even on partial success.

POWER TIER AWARENESS. You will receive the character's power context. Calibrate:
- OP mode active: the protagonist is INTENTIONALLY overpowered. Routine power use (casting, abilities, basic combat) is DC 5 with NO cost and NO consequence. Do not invent strain, fatigue, or "the price of power" for abilities used a thousand times — a character using everyday abilities is like a human walking.
- Assign cost/consequence ONLY when: the action pushes beyond established limits; the story is at a dramatic turning point where sacrifice adds weight; or the player explicitly chose a reckless approach.
- Standard actions against weaker opposition: no cost, generous DC.

DIFFICULTY CLASS
- 5 trivial (routine, well within capability) · 10 easy (basic competence) · 15 moderate (challenging for a pro) · 20 hard (significant risk) · 25 heroic (near impossible) · 30 anime logic (only with extreme buffs/narrative weight).

MODIFIERS. List each distinct modifier as a signed string: "+2 High Ground", "+5 Friendship Power", "-3 Injured". When character tier vastly exceeds the demand: "+10 Vastly Overpowered". The engine sums the leading integers — every modifier string MUST begin with +N or -N.

THE DIE IS ALREADY ROLLED. You receive the natural d20 face. Set the DC and modifiers; state the arithmetic in your rationale as "Roll: X + Y = Z vs DC W". The engine recomputes the band; your success_level should match:
- natural 1 → critical_failure (catastrophic fumble — describe it vividly)
- natural 20, or total ≥ DC+10 → critical_success
- total ≥ DC → success
- total ≥ DC−4 → partial_success (achieved intent WITH a complication — set cost or consequence)
- otherwise → failure (did not achieve intent; failure is part of the story now — never the engine defending its plot)

NARRATIVE WEIGHT: MINOR (a beat), SIGNIFICANT (a scene), CLIMACTIC (screen time, sakuga territory).`;

export interface OutcomeJudgment {
  outcome: OutcomeOutput;
  roll: D20Roll;
  mechanics: PreResolvedMechanics;
}

/** Douga turns skip the judge: synthetic success at minor weight (§5.1). */
export function syntheticOutcome(): OutcomeJudgment {
  const roll: D20Roll = { natural: 15, rollType: "normal", faces: [15] };
  return {
    roll,
    outcome: {
      success_level: "success",
      difficulty_class: 5,
      modifiers: [],
      narrative_weight: "MINOR",
      rationale: "Trivial action — synthetic success, no judgment call (douga contract).",
    },
    mechanics: {
      rolls: [
        { sides: 20, rolled: 15, modifier: 0, total: 15, purpose: "douga synthetic success" },
      ],
      resource_spends: [],
    },
  };
}

export async function judgeOutcome(
  selection: TierSelection,
  args: {
    intent: IntentOutput;
    playerInput: string;
    powerContext: string;
    memories: string[];
    correction?: string;
    campaignId: string;
    turnNumber: number;
    /** Reuse a prior roll (validation retry re-judges the SAME die, §5.7). */
    roll?: D20Roll;
  },
): Promise<OutcomeJudgment> {
  const roll = args.roll ?? rollD20();
  const outcome = await callJudgment(selection, {
    name: "outcome_judgment",
    schema: OutcomeOutput,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    system: OUTCOME_SYSTEM,
    prompt: [
      `PLAYER ACTION: ${args.playerInput}`,
      `INTENT: ${args.intent.intent}${args.intent.action ? ` — ${args.intent.action}` : ""}${args.intent.target ? ` → ${args.intent.target}` : ""}`,
      `EPICNESS: ${args.intent.epicness}`,
      args.powerContext ? `POWER CONTEXT: ${args.powerContext}` : "",
      args.memories.length > 0
        ? `RELEVANT CONTEXT:\n${args.memories.map((m) => `- ${m}`).join("\n")}`
        : "",
      `THE DIE SHOWS: natural ${roll.natural} (d20${roll.rollType !== "normal" ? `, ${roll.rollType}: faces ${roll.faces.join("/")}` : ""})`,
      args.correction
        ? `VALIDATOR CORRECTION (re-judge with this in mind): ${args.correction}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    effort: "high",
    maxTokens: STRUCTURED_RICH,
  });

  // The code owns the arithmetic: recompute the band from the actual die and
  // the judge's own DC/modifiers; correct the judge if it disagreed.
  const modifier = sumModifiers(outcome.modifiers);
  const total = roll.natural + modifier;
  const band = successBand(roll.natural, total, outcome.difficulty_class);
  const corrected: OutcomeOutput = { ...outcome, success_level: band };

  const mechanics: PreResolvedMechanics = {
    rolls: [
      {
        sides: 20,
        rolled: roll.natural,
        modifier,
        total,
        purpose: `outcome vs DC ${outcome.difficulty_class}`,
      },
    ],
    resource_spends: [],
  };
  return { outcome: corrected, roll, mechanics };
}

// --- Validation (sakuga tier; one retry — §5.1) ------------------------------

const ValidationOutput = z.object({
  is_valid: z.boolean(),
  /** Present when invalid: what the re-judge must respect. */
  correction: z.string().optional(),
});
export type ValidationOutput = z.infer<typeof ValidationOutput>;

/**
 * The simple referee (v3 validator.md): power scaling ("a normal human
 * punches a tank — their hand breaks, not the tank"), logical consistency,
 * rule adherence. One retry re-judges the SAME die with the correction.
 */
export async function validateOutcome(
  selection: TierSelection,
  args: {
    outcome: OutcomeOutput;
    intent: IntentOutput;
    playerInput: string;
    powerContext: string;
    campaignId: string;
    turnNumber: number;
  },
): Promise<ValidationOutput> {
  try {
    return await callJudgment(selection, {
      name: "outcome_validation",
      schema: ValidationOutput,
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
      system: [
        "You are the outcome validator — a simple referee. Check the judged",
        "outcome for: POWER SCALING (a normal human punching a tank breaks",
        "their hand, not the tank; respect the stated power context, incl.",
        "OP mode where trivial DCs are CORRECT), LOGICAL CONSISTENCY (can't",
        "act on things not present; unconscious characters don't act), and",
        "RULE ADHERENCE (established world rules: chant requirements, costs",
        "the world imposes). A climactic success with zero acknowledgment of",
        "stakes is suspect. If invalid, give ONE terse correction the",
        "re-judge must respect. Do not manufacture problems — valid is the",
        "common case.",
      ].join(" "),
      prompt: [
        `PLAYER ACTION: ${args.playerInput}`,
        `POWER CONTEXT: ${args.powerContext || "(none)"}`,
        `JUDGED: ${args.outcome.success_level} vs DC ${args.outcome.difficulty_class}; weight ${args.outcome.narrative_weight}`,
        `MODIFIERS: ${args.outcome.modifiers.join(", ") || "(none)"}`,
        `COST: ${args.outcome.cost ?? "(none)"} · CONSEQUENCE: ${args.outcome.consequence ?? "(none)"}`,
        `RATIONALE: ${args.outcome.rationale}`,
      ].join("\n"),
      maxTokens: STRUCTURED_SMALL,
    });
  } catch (err) {
    console.warn("[layout] validation call failed — treating as valid", err);
    return { is_valid: true };
  }
}
