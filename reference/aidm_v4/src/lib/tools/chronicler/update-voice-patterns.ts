import { voicePatterns } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Append a voice-pattern observation to the Director's journal. KA reads
 * the accumulated patterns in Block 1 as voice_patterns_journal, so an
 * append here directly shapes the next turn's narration cadence.
 *
 * Name is a misnomer — "update" implies mutate, but rows are append-only
 * (each observation is a new row at a specific turn). Chronicler may
 * write several per turn; the journal's aggregate shape is what matters,
 * not individual row ordering.
 */
const InputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Short observation, e.g. "terse two-sentence openings land well"'),
  evidence: z
    .string()
    .default("")
    .describe("What specifically in the narration led to this observation"),
  turn_observed: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
});

export const updateVoicePatternsTool = registerTool({
  name: "update_voice_patterns",
  description:
    "Append a voice-pattern observation (append-only journal). KA reads the aggregate in Block 1 each turn, so new patterns take effect next turn.",
  layer: "voice",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(voicePatterns)
      .values({
        campaignId: ctx.campaignId,
        pattern: input.pattern,
        evidence: input.evidence,
        turnObserved: input.turn_observed,
      })
      .returning({ id: voicePatterns.id });
    if (!row) throw new Error("update_voice_patterns: insert returned no row");
    return { id: row.id };
  },
});
