import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Keyword search over turn transcripts. Returns the turn numbers whose
 * narrative prose matches the keyword, with short excerpts. Stub until
 * Commit 6 lands the `turns` table with its tsvector index.
 */
const InputSchema = z.object({
  keyword: z.string().min(1).describe("Phrase or keyword to match against narrative prose"),
  turn_range: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .optional()
    .describe("Optional turn-number window to restrict the search"),
  limit: z.number().int().min(1).max(20).default(5),
});

const OutputSchema = z.object({
  hits: z.array(
    z.object({
      turn: z.number(),
      score: z.number(),
      excerpt: z.string(),
    }),
  ),
});

export const recallSceneTool = registerTool({
  name: "recall_scene",
  description:
    "Keyword / tsvector search over the campaign's turn transcripts. Returns matching turn numbers with short prose excerpts. Use get_turn_narrative to pull a full turn after a hit.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { hits: [] };
  },
});
