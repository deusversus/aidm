import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return the Director's voice_patterns journal — observations of what's
 * landed stylistically with this player across sessions. Feeds KA's
 * Block 1. Stub until Director runs (post-SZ at M2; depth at M4).
 */
const InputSchema = z.object({});

const OutputSchema = z.object({
  patterns: z.array(
    z.object({
      observation: z.string(),
      recorded_at_turn: z.number(),
      category: z.enum(["opening", "cadence", "emotional_move", "dialogue", "structural", "other"]),
    }),
  ),
});

export const getVoicePatternsTool = registerTool({
  name: "get_voice_patterns",
  description:
    "Return Director's voice-patterns journal: observations of phrasings, cadences, and structural moves that resonated with this player.",
  layer: "voice",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { patterns: [] };
  },
});
