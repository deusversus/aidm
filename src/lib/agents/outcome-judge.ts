import { getPrompt } from "@/lib/prompts";
import { type IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * OutcomeJudge — thinking-tier consultant that decides whether the
 * player's action succeeds, at what cost, and how consequentially.
 *
 * KA invokes before narrating consequences. OJ produces mechanical
 * truth (success level, DC, narrative weight, consequence, cost,
 * rationale); KA narrates it. Opus 4.7 with extended thinking budget
 * 2K per ROADMAP §5.4.
 *
 * The output schema is the shared `OutcomeOutput` from
 * `src/lib/types/turn.ts` so callers can hand it to persistence + KA's
 * Block 4 rendering without conversion.
 */

const CHARACTER_STATE_STUB = z
  .object({
    name: z.string().optional(),
    power_tier: z.string().optional(),
    summary: z.string().optional(),
  })
  .partial();

const ARC_STATE_STUB = z
  .object({
    current_arc: z.string().nullable().optional(),
    arc_phase: z.string().nullable().optional(),
    tension_level: z.number().min(0).max(1).nullable().optional(),
  })
  .partial();

export const OutcomeJudgeInput = z.object({
  intent: z.custom<IntentOutput>(),
  playerMessage: z.string().min(1),
  characterSummary: CHARACTER_STATE_STUB.default({}),
  situation: z.string().default(""),
  arcState: ARC_STATE_STUB.default({}),
  activeConsequences: z.array(z.string()).default([]),
  /**
   * When Validator rejects a prior OJ output, the caller invokes OJ
   * again with this field set — OJ weights the correction and tries
   * a different read. See `judgeOutcomeWithValidation` below.
   */
  validatorCorrection: z.string().optional(),
});
export type OutcomeJudgeInput = z.input<typeof OutcomeJudgeInput>;

function buildUserContent(input: z.output<typeof OutcomeJudgeInput>): string {
  const consequences = input.activeConsequences.length
    ? input.activeConsequences.map((c) => `  - ${c}`).join("\n")
    : "  (none)";
  const correction = input.validatorCorrection
    ? [
        "",
        "⚠ Validator correction from prior attempt:",
        `  ${input.validatorCorrection}`,
        "Reconsider with this in mind.",
      ].join("\n")
    : "";
  return [
    `intent: ${JSON.stringify(input.intent)}`,
    `playerMessage: ${input.playerMessage}`,
    `characterSummary: ${JSON.stringify(input.characterSummary)}`,
    `situation: ${input.situation || "(unspecified)"}`,
    `arcState: ${JSON.stringify(input.arcState)}`,
    "activeConsequences:",
    consequences,
    correction,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function fallbackOutcome(): OutcomeOutput {
  // Neutral fallback: partial_success with no consequence/cost. This
  // lets KA narrate something coherent without OJ's judgment while
  // making it obvious in the trace that judgment was skipped.
  return {
    success_level: "partial_success",
    difficulty_class: 12,
    modifiers: [],
    narrative_weight: "MINOR",
    consequence: undefined,
    cost: undefined,
    rationale: "OJ fallback — judge unavailable; returning neutral outcome",
  };
}

export async function judgeOutcome(
  input: OutcomeJudgeInput,
  deps: AgentRunnerDeps = {},
): Promise<OutcomeOutput> {
  const parsed = OutcomeJudgeInput.parse(input);
  return runStructuredAgent(
    {
      agentName: "outcome-judge",
      tier: "thinking",
      systemPrompt: getPrompt("agents/outcome-judge").content,
      userContent: buildUserContent(parsed),
      outputSchema: OutcomeOutput,
      fallback: fallbackOutcome(),
      thinkingBudget: 2048,
      maxTokens: 4096,
    },
    deps,
  );
}
