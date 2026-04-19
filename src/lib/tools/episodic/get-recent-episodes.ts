import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return short summaries of the most recent N turns. Used for continuity
 * rather than deep recall — if KA wants the actual prose of a specific
 * turn, use `get_turn_narrative` instead. Stub until Commit 6.
 */
const InputSchema = z.object({
  n: z.number().int().min(1).max(20).default(5),
});

const OutputSchema = z.object({
  episodes: z.array(
    z.object({
      turn_number: z.number(),
      summary: z.string(),
      intent: z.string().nullable(),
    }),
  ),
});

export const getRecentEpisodesTool = registerTool({
  name: "get_recent_episodes",
  description: "Return short summaries of the most recent N turns for continuity context.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { episodes: [] };
  },
});
