import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Semantic search over distilled cross-turn memories. Queries the
 * semantic-memory layer (pgvector + category decay + heat boost). Stub
 * until M4's memory writer populates content. Returns an empty `memories`
 * array — KA treats that as "no relevant memory yet" rather than error.
 */
const InputSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).default(5),
  categories: z
    .array(
      z.enum([
        "core",
        "session_zero",
        "session_zero_voice",
        "relationship",
        "consequence",
        "fact",
        "npc_interaction",
        "location",
        "narrative_beat",
        "quest",
        "world_state",
        "event",
        "npc_state",
        "character_state",
        "episode",
      ]),
    )
    .optional()
    .describe("Restrict to specific memory categories (§9.1)"),
  min_heat: z.number().min(0).max(100).default(0),
});

const OutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      fragment: z.string().nullable().describe("Storyboarded prose fragment for voice recall"),
      category: z.string(),
      heat: z.number(),
      relevance: z.number(),
      created_turn: z.number(),
    }),
  ),
});

export const searchMemoryTool = registerTool({
  name: "search_memory",
  description:
    "Semantic search over distilled cross-turn memory. Returns ranked facts + their storyboarded prose fragments.",
  layer: "semantic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { memories: [] };
  },
});
