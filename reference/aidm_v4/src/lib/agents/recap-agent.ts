import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * RecapAgent — first-turn-of-session catch-up.
 *
 * KA invokes this when a player returns from a break. Produces 2-4
 * sentences of in-character orientation (cliffhanger reminder, active
 * threads, NPCs likely to appear). Short. In-character. Returns
 * `recap: null` when there's no prior session to recap.
 */

const PriorTurnSchema = z.object({
  turn: z.number().int().nonnegative(),
  summary: z.string(),
});

export const RecapAgentInput = z.object({
  priorSessionTurns: z.array(PriorTurnSchema).default([]),
  activeThreads: z.array(z.string()).default([]),
});
export type RecapAgentInput = z.input<typeof RecapAgentInput>;

export const RecapAgentOutput = z.object({
  recap: z.string().nullable(),
  hooksMentioned: z.array(z.string()).default([]),
});
export type RecapAgentOutput = z.infer<typeof RecapAgentOutput>;

function buildUserContent(input: z.output<typeof RecapAgentInput>): string {
  const priors = input.priorSessionTurns.length
    ? input.priorSessionTurns.map((t) => `  - turn ${t.turn}: ${t.summary}`).join("\n")
    : "  (none — this is the first session)";
  const threads = input.activeThreads.length
    ? input.activeThreads.map((t) => `  - ${t}`).join("\n")
    : "  (none)";
  return [
    "priorSessionTurns:",
    priors,
    "",
    "activeThreads:",
    threads,
    "",
    "Return the JSON object now. Return `recap: null` if there's nothing worth recapping.",
  ].join("\n");
}

export async function produceRecap(
  input: RecapAgentInput,
  deps: AgentRunnerDeps = {},
): Promise<RecapAgentOutput> {
  const parsed = RecapAgentInput.parse(input);
  // Short-circuit: no prior turns means no recap to produce; don't burn
  // a model call to have it tell us that.
  if (parsed.priorSessionTurns.length === 0) {
    return { recap: null, hooksMentioned: [] };
  }
  // Fallback: skip recap rather than surface a broken one. Missing
  // recap is a soft degradation; wrong recap is a broken scene.
  const fallback: RecapAgentOutput = { recap: null, hooksMentioned: [] };
  return runStructuredAgent(
    {
      agentName: "recap-agent",
      tier: "fast",
      systemPrompt: getPrompt("agents/recap-agent").content,
      promptId: "agents/recap-agent",
      userContent: buildUserContent(parsed),
      outputSchema: RecapAgentOutput,
      fallback,
    },
    deps,
  );
}
