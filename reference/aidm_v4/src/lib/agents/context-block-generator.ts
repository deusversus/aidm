import { getPrompt } from "@/lib/prompts";
import { ContextBlockType } from "@/lib/types/entities";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * ContextBlockGenerator — fast-tier archivist-biographer.
 *
 * Given an entity (arc / quest / NPC / faction / location / thread) +
 * its structured data + related turn summaries + related memories + an
 * optional prior version of the block, produce a new living prose
 * summary KA reads at session start. Replaces scattered-memory-recall
 * with "here's the document for this entity."
 *
 * Runs on the campaign's fast tier. Output is structured — distilled
 * prose + flat k:v continuity checklist. Failure falls back to a
 * stamped "regeneration pending" block that won't block the session
 * but signals to Chronicler to retry.
 *
 * Phase 3B of v3-audit closure (docs/plans/v3-audit-closure.md §3.2).
 */

export const ContextBlockGeneratorInput = z.object({
  blockType: ContextBlockType,
  entityName: z.string().min(1),
  /**
   * Structured entity data (NPCDetails for NPCs, arc plan for arcs,
   * location details for locations, etc.). Free-form record because
   * the shape varies by block_type.
   */
  entityData: z.record(z.string(), z.unknown()).default({}),
  /**
   * Recent turn summaries relevant to this entity (from episodic
   * layer). Array of "Turn N: prose" strings. Empty is fine for
   * fresh entities with no history.
   */
  relatedTurns: z.array(z.string()).default([]),
  /**
   * Semantic memories touching this entity. Array of distilled facts.
   * Empty is fine.
   */
  relatedMemories: z.array(z.string()).default([]),
  /**
   * Prior version's `content` + `continuity_checklist` when this is a
   * re-generation. Null for first-time block creation.
   */
  priorVersion: z
    .object({
      content: z.string(),
      continuity_checklist: z.record(z.string(), z.unknown()),
      version: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type ContextBlockGeneratorInput = z.input<typeof ContextBlockGeneratorInput>;

export const ContextBlockGeneratorOutput = z.object({
  content: z.string().min(1),
  /** Flat k:v — primitives only; values are string | number | boolean. */
  continuity_checklist: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
export type ContextBlockGeneratorOutput = z.infer<typeof ContextBlockGeneratorOutput>;

export type ContextBlockGeneratorDeps = AgentRunnerDeps;

function buildUserContent(input: z.output<typeof ContextBlockGeneratorInput>): string {
  const turns = input.relatedTurns.length
    ? input.relatedTurns.map((t) => `  - ${t}`).join("\n")
    : "  (none)";
  const mems = input.relatedMemories.length
    ? input.relatedMemories.map((m) => `  - ${m}`).join("\n")
    : "  (none)";
  const prior = input.priorVersion
    ? `prior_version (v${input.priorVersion.version}):\n  content:\n${input.priorVersion.content
        .split("\n")
        .map((l) => `    ${l}`)
        .join(
          "\n",
        )}\n  continuity_checklist: ${JSON.stringify(input.priorVersion.continuity_checklist, null, 2)}`
    : "prior_version: (none — this is the first version of the block)";

  return [
    `blockType: ${input.blockType}`,
    `entityName: ${input.entityName}`,
    `entityData: ${JSON.stringify(input.entityData, null, 2)}`,
    "",
    "relatedTurns:",
    turns,
    "",
    "relatedMemories:",
    mems,
    "",
    prior,
    "",
    "Produce the JSON object now.",
  ].join("\n");
}

export async function generateContextBlock(
  input: ContextBlockGeneratorInput,
  deps: ContextBlockGeneratorDeps = {},
): Promise<ContextBlockGeneratorOutput> {
  const parsed = ContextBlockGeneratorInput.parse(input);

  // Fallback: mark this block as "regeneration pending" in a way that
  // both unblocks the session + signals Chronicler to retry. Worth
  // being explicit in prose so a session briefing still parses.
  const fallback: ContextBlockGeneratorOutput = {
    content: `**${parsed.entityName}** — context block regeneration pending. Prior version is the load-bearing record until the next successful generation completes.`,
    continuity_checklist: { regeneration_pending: true },
  };

  return runStructuredAgent(
    {
      agentName: "context-block-generator",
      tier: "fast",
      systemPrompt: getPrompt("agents/context-block-generator").content,
      promptId: "agents/context-block-generator",
      userContent: buildUserContent(parsed),
      outputSchema: ContextBlockGeneratorOutput,
      fallback,
      maxTokens: 1200,
    },
    deps,
  );
}
