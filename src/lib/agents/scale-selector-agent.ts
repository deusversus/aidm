import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * ScaleSelectorAgent — computes the effective composition mode for a
 * specific combat exchange based on attacker/defender tier gap.
 *
 * Profile's `composition.mode` is the campaign default; this agent
 * returns the per-exchange override when the power differential
 * warrants (Tier 3 protagonist vs Tier 9 mook → op_dominant; etc.).
 * Fast tier — this is classification, not reasoning.
 */

export const CompositionMode = z.enum(["standard", "blended", "op_dominant", "not_applicable"]);
export type CompositionMode = z.infer<typeof CompositionMode>;

const PowerTier = z.enum(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]);

export const ScaleSelectorInput = z.object({
  attackerTier: PowerTier,
  defenderTier: PowerTier,
  environmentalFactors: z.array(z.string()).default([]),
  profileCompositionMode: CompositionMode.default("standard"),
});
export type ScaleSelectorInput = z.input<typeof ScaleSelectorInput>;

export const ScaleSelectorOutput = z.object({
  effectiveMode: CompositionMode,
  tensionScaling: z.number().min(0).max(1),
  rationale: z.string(),
});
export type ScaleSelectorOutput = z.infer<typeof ScaleSelectorOutput>;

function buildUserContent(input: z.output<typeof ScaleSelectorInput>): string {
  const env = input.environmentalFactors.length
    ? input.environmentalFactors.map((f) => `  - ${f}`).join("\n")
    : "  (none)";
  return [
    `attackerTier: ${input.attackerTier}`,
    `defenderTier: ${input.defenderTier}`,
    `environmentalFactors:\n${env}`,
    `profileCompositionMode: ${input.profileCompositionMode}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function selectScale(
  input: ScaleSelectorInput,
  deps: AgentRunnerDeps = {},
): Promise<ScaleSelectorOutput> {
  const parsed = ScaleSelectorInput.parse(input);
  // Fallback: use the profile's campaign-default mode at mid tension.
  // Safe: matches whatever the rest of the system assumes when this
  // agent didn't run.
  const fallback: ScaleSelectorOutput = {
    effectiveMode: parsed.profileCompositionMode,
    tensionScaling: 0.5,
    rationale: "scale-selector fallback — using profile default mode",
  };
  return runStructuredAgent(
    {
      agentName: "scale-selector-agent",
      tier: "fast",
      systemPrompt: getPrompt("agents/scale-selector-agent").content,
      userContent: buildUserContent(parsed),
      outputSchema: ScaleSelectorOutput,
      fallback,
    },
    deps,
  );
}
