import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";
import { OverrideCategory } from "./override-handler";

/**
 * MetaDirector — fast-tier authorship-calibration voice for the /meta
 * conversation loop (Phase 5 of v3-audit closure).
 *
 * The player has paused the story to talk ABOUT the story. This agent
 * responds in author/director voice — not narrating, not playing NPCs,
 * just conversing about craft + calibration. Optionally proposes an
 * override when the player's feedback is a clear hard constraint.
 *
 * Runs on the campaign's fast tier. Structured output (response +
 * optional suggested_override). Fallback on parse failure: a generic
 * "noted" reply so the dialectic doesn't stall.
 */

export const MetaDirectorInput = z.object({
  playerMessage: z.string().min(1),
  /**
   * Prior meta-conversation history — messages already exchanged in
   * THIS /meta loop. Ordered oldest → newest. Empty when the player
   * just opened the loop.
   */
  history: z
    .array(
      z.object({
        role: z.enum(["player", "director", "ka"]),
        text: z.string(),
      }),
    )
    .default([]),
  /**
   * Short blurb about the current campaign state KA would otherwise
   * reference — lets MetaDirector speak informedly without a full
   * Block 1 render. Caller (route handler) assembles 2–3 sentences.
   */
  campaignSummary: z.string().default(""),
});
export type MetaDirectorInput = z.input<typeof MetaDirectorInput>;

export const SuggestedOverride = z.object({
  category: OverrideCategory,
  value: z.string().min(1),
});
export type SuggestedOverride = z.infer<typeof SuggestedOverride>;

export const MetaDirectorOutput = z.object({
  response: z.string().min(1),
  suggested_override: SuggestedOverride.nullable().default(null),
});
export type MetaDirectorOutput = z.infer<typeof MetaDirectorOutput>;

export type MetaDirectorDeps = AgentRunnerDeps;

function buildUserContent(input: z.output<typeof MetaDirectorInput>): string {
  const historyLines = input.history.length
    ? input.history.map((m) => `  [${m.role}] ${m.text}`).join("\n")
    : "  (this is the first exchange of the meta conversation)";
  return [
    `playerMessage: ${input.playerMessage}`,
    "",
    "priorHistory:",
    historyLines,
    "",
    `campaignSummary: ${input.campaignSummary || "(none provided)"}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function runMetaDirector(
  input: MetaDirectorInput,
  deps: MetaDirectorDeps = {},
): Promise<MetaDirectorOutput> {
  const parsed = MetaDirectorInput.parse(input);
  const fallback: MetaDirectorOutput = {
    response:
      "Heard. I'll hold that and weigh it as we continue — say `/resume` when you're ready to pick the scene back up.",
    suggested_override: null,
  };
  return runStructuredAgent(
    {
      agentName: "meta-director",
      tier: "fast",
      systemPrompt: getPrompt("agents/meta-director").content,
      promptId: "agents/meta-director",
      userContent: buildUserContent(parsed),
      outputSchema: MetaDirectorOutput,
      fallback,
      maxTokens: 512,
    },
    deps,
  );
}
