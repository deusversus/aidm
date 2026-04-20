import { getPrompt } from "@/lib/prompts";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";
import { judgeOutcome } from "./outcome-judge";
import { CompositionMode } from "./scale-selector-agent";

/**
 * Validator — thinking-tier reviewer of OutcomeJudge verdicts.
 *
 * KA invokes when OJ's verdict warrants a consistency check against
 * canon, character capabilities, composition mode, or active player
 * overrides. If the verdict is sound, validator passes through; if
 * not, validator returns a `correction` string and KA re-invokes OJ
 * with that correction. One retry cap.
 *
 * `judgeOutcomeWithValidation` below is the convenience wrapper that
 * does OJ → Validator → (if invalid) OJ-with-correction → return.
 */

export const ValidatorInput = z.object({
  intent: z.custom<IntentOutput>(),
  proposedOutcome: z.custom<OutcomeOutput>(),
  characterSummary: z.record(z.string(), z.unknown()).default({}),
  canonRules: z.array(z.string()).default([]),
  compositionMode: CompositionMode.default("standard"),
  activeOverrides: z.array(z.object({ category: z.string(), value: z.string() })).default([]),
});
export type ValidatorInput = z.input<typeof ValidatorInput>;

export const ValidatorOutput = z.object({
  valid: z.boolean(),
  correction: z.string().nullable(),
});
export type ValidatorOutput = z.infer<typeof ValidatorOutput>;

function buildUserContent(input: z.output<typeof ValidatorInput>): string {
  const canon = input.canonRules.length
    ? input.canonRules.map((r) => `  - ${r}`).join("\n")
    : "  (none)";
  const overrides = input.activeOverrides.length
    ? input.activeOverrides.map((o) => `  - [${o.category}] ${o.value}`).join("\n")
    : "  (none)";
  return [
    `intent: ${JSON.stringify(input.intent)}`,
    `proposedOutcome: ${JSON.stringify(input.proposedOutcome)}`,
    `characterSummary: ${JSON.stringify(input.characterSummary)}`,
    `compositionMode: ${input.compositionMode}`,
    "canonRules:",
    canon,
    "activeOverrides:",
    overrides,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function validateOutcome(
  input: ValidatorInput,
  deps: AgentRunnerDeps = {},
): Promise<ValidatorOutput> {
  const parsed = ValidatorInput.parse(input);
  // Fallback: pass through (valid: true). On validator infra failure
  // we trust OJ's verdict rather than block the turn. Surfacing this
  // in Langfuse is sufficient — consistency bugs caught downstream
  // are rare enough to accept the risk.
  const fallback: ValidatorOutput = { valid: true, correction: null };
  return runStructuredAgent(
    {
      agentName: "validator",
      tier: "thinking",
      systemPrompt: getPrompt("agents/validator").content,
      promptId: "agents/validator",
      userContent: buildUserContent(parsed),
      outputSchema: ValidatorOutput,
      fallback,
      maxTokens: 512,
    },
    deps,
  );
}

/**
 * Orchestrator: judgeOutcome → validateOutcome → (if invalid)
 * judgeOutcome again with the correction → return.
 *
 * This is the shape KA actually invokes. One retry cap — if the second
 * OJ pass still fails validation, we return it anyway. Validator is a
 * sanity check, not a gate that can block the turn indefinitely.
 */
export async function judgeOutcomeWithValidation(
  ojInput: z.input<typeof import("./outcome-judge").OutcomeJudgeInput>,
  validatorContext: Omit<ValidatorInput, "intent" | "proposedOutcome">,
  deps: AgentRunnerDeps = {},
): Promise<{
  outcome: OutcomeOutput;
  validator: ValidatorOutput;
  retried: boolean;
}> {
  const firstPass = await judgeOutcome(ojInput, deps);
  const firstValidation = await validateOutcome(
    { ...validatorContext, intent: ojInput.intent, proposedOutcome: firstPass },
    deps,
  );
  if (firstValidation.valid || !firstValidation.correction) {
    return { outcome: firstPass, validator: firstValidation, retried: false };
  }
  const secondPass = await judgeOutcome(
    { ...ojInput, validatorCorrection: firstValidation.correction },
    deps,
  );
  // Second validation only for trace completeness — don't loop again.
  const secondValidation = await validateOutcome(
    {
      ...validatorContext,
      intent: ojInput.intent,
      proposedOutcome: secondPass,
    },
    deps,
  );
  return { outcome: secondPass, validator: secondValidation, retried: true };
}
