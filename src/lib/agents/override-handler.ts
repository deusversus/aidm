import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * OverrideHandler — classifies `/meta` and `/override` commands.
 *
 * Two command families, very different binding semantics:
 *   - `/override` — hard constraint. Becomes part of KA's Block 4 as
 *     `## PLAYER OVERRIDES (MUST BE ENFORCED)`.
 *   - `/meta` — advisory calibration. Persisted as a
 *     session_zero_voice-category memory; KA weighs, doesn't obey.
 *
 * The handler parses one command at a time. The router extracts the
 * command prefix (`/override X` → passes "X" here with mode "override"),
 * and the handler fills in category, scope, conflicts, and an
 * acknowledgement the player sees.
 *
 * Tier: fast. Provider follows the campaign's modelContext (M1.5).
 * Failure policy: parse fail → runner retries once → fallback that
 * surfaces the raw command as a NARRATIVE_DEMAND override (never
 * silently drops). The fallback is input-dependent, computed at call
 * time from the parsed command.
 */

export const OverrideMode = z.enum(["override", "meta"]);
export const OverrideCategory = z.enum([
  "NPC_PROTECTION",
  "CONTENT_CONSTRAINT",
  "NARRATIVE_DEMAND",
  "TONE_REQUIREMENT",
]);
export const OverrideScope = z.enum(["campaign", "session", "arc"]);

export const OverrideHandlerInput = z.object({
  command: z
    .string()
    .min(1)
    .describe("Raw command text (may include leading /override or /meta prefix)"),
  prior_overrides: z
    .array(
      z.object({
        id: z.string(),
        category: OverrideCategory,
        value: z.string(),
        scope: OverrideScope,
      }),
    )
    .default([]),
});
// Use input-side type so callers can omit defaulted fields.
export type OverrideHandlerInput = z.input<typeof OverrideHandlerInput>;

export const OverrideHandlerOutput = z.object({
  mode: OverrideMode,
  category: OverrideCategory.nullable(),
  value: z.string().min(1),
  scope: OverrideScope.default("campaign"),
  conflicts_with: z.array(z.string()).default([]),
  ack_phrasing: z.string().min(1),
});
export type OverrideHandlerOutput = z.infer<typeof OverrideHandlerOutput>;

export type OverrideHandlerDeps = AgentRunnerDeps;

function buildUserContent(input: z.output<typeof OverrideHandlerInput>): string {
  const priors = input.prior_overrides.length
    ? input.prior_overrides
        .map((o) => `  - [${o.id}] ${o.category} (${o.scope}): ${o.value}`)
        .join("\n")
    : "  (none)";
  return [
    `command: ${input.command}`,
    `prior_overrides:\n${priors}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function buildFallback(input: z.output<typeof OverrideHandlerInput>): OverrideHandlerOutput {
  const isOverride = /^\s*\/override\b/i.test(input.command);
  const stripped = input.command.replace(/^\s*\/(?:override|meta)\s*/i, "").trim();
  return {
    mode: isOverride ? "override" : "meta",
    category: isOverride ? "NARRATIVE_DEMAND" : null,
    value: stripped || input.command,
    scope: "campaign",
    conflicts_with: [],
    ack_phrasing: isOverride
      ? "Noted. Recorded as-written."
      : "Heard. I'll weigh it as the story continues.",
  };
}

export async function handleOverride(
  input: OverrideHandlerInput,
  deps: OverrideHandlerDeps = {},
): Promise<OverrideHandlerOutput> {
  const parsed = OverrideHandlerInput.parse(input);
  return runStructuredAgent(
    {
      agentName: "override-handler",
      tier: "fast",
      systemPrompt: getPrompt("agents/override-handler").content,
      userContent: buildUserContent(parsed),
      outputSchema: OverrideHandlerOutput,
      fallback: buildFallback(parsed),
      maxTokens: 512,
      temperature: 0.1,
      spanInput: parsed,
    },
    deps,
  );
}
