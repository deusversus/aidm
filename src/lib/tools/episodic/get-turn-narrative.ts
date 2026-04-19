import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Pull the full narrative prose of a specific turn. Use after `recall_scene`
 * returns a hit. Stub until the `turns` table lands in Commit 6.
 */
const InputSchema = z.object({
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  turn_number: z.number(),
  player_message: z.string().nullable(),
  narrative_text: z.string().nullable(),
  intent: z.string().nullable(),
  outcome_summary: z.string().nullable(),
});

export const getTurnNarrativeTool = registerTool({
  name: "get_turn_narrative",
  description:
    "Return the full narrative prose of a specific turn, plus the player message, intent, and outcome that produced it.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, _ctx) => {
    return {
      available: false,
      turn_number: input.turn_number,
      player_message: null,
      narrative_text: null,
      intent: null,
      outcome_summary: null,
    };
  },
});
