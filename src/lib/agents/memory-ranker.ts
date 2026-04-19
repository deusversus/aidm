import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * MemoryRanker — fast-tier reranker over semantic-memory candidates.
 *
 * Embedding similarity is a starting point, not the answer. When the raw
 * retrieval returns more than 3 hits, this agent re-ranks them by
 * relevance to the specific moment, using judgment the similarity score
 * can't capture.
 */

const CandidateSchema = z.object({
  id: z.string(),
  content: z.string(),
  category: z.string(),
  heat: z.number(),
  baseScore: z.number(),
});

export const MemoryRankerInput = z.object({
  intent: z.string(),
  playerMessage: z.string().min(1),
  candidates: z.array(CandidateSchema).min(1),
  sceneContext: z
    .object({
      location: z.string().nullable().default(null),
      situation: z.string().nullable().default(null),
      present_npcs: z.array(z.string()).default([]),
    })
    .default(() => ({ location: null, situation: null, present_npcs: [] })),
});
export type MemoryRankerInput = z.input<typeof MemoryRankerInput>;

export const MemoryRankerOutput = z.object({
  ranked: z.array(
    z.object({
      id: z.string(),
      relevanceScore: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
  dropped: z.array(z.string()).default([]),
});
export type MemoryRankerOutput = z.infer<typeof MemoryRankerOutput>;

function buildUserContent(input: z.output<typeof MemoryRankerInput>): string {
  const candidates = input.candidates
    .map(
      (c) =>
        `  - id=${c.id} category=${c.category} heat=${c.heat.toFixed(1)} score=${c.baseScore.toFixed(2)}\n    content: ${c.content}`,
    )
    .join("\n");
  return [
    `intent: ${input.intent}`,
    `playerMessage: ${input.playerMessage}`,
    `sceneContext.location: ${input.sceneContext.location ?? "(unknown)"}`,
    `sceneContext.situation: ${input.sceneContext.situation ?? "(unknown)"}`,
    `sceneContext.present_npcs: ${input.sceneContext.present_npcs.join(", ") || "(none)"}`,
    "",
    "candidates:",
    candidates,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function rankMemories(
  input: MemoryRankerInput,
  deps: AgentRunnerDeps = {},
): Promise<MemoryRankerOutput> {
  const parsed = MemoryRankerInput.parse(input);
  // Fallback preserves the input ordering. If the ranker fails, KA
  // gets the embedding-score order back, which is always better than
  // empty.
  const fallback: MemoryRankerOutput = {
    ranked: parsed.candidates.map((c) => ({
      id: c.id,
      relevanceScore: c.baseScore,
      reason: "ranker fallback — preserving embedding order",
    })),
    dropped: [],
  };
  return runStructuredAgent(
    {
      agentName: "memory-ranker",
      tier: "fast",
      systemPrompt: getPrompt("agents/memory-ranker").content,
      userContent: buildUserContent(parsed),
      outputSchema: MemoryRankerOutput,
      fallback,
    },
    deps,
  );
}
