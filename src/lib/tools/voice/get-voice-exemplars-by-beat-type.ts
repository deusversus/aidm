import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return short voice exemplars — specific prior prose moves that worked
 * for a given beat type (frozen_moment, aftermath, montage, climax, etc.).
 * KA uses these as reference material when it's trying to hit a similar
 * beat again.
 *
 * Populated by Director as it watches the campaign and flags moves that
 * resonated. Stub until voice journal accumulates content.
 */
const InputSchema = z.object({
  beat_type: z.enum([
    "frozen_moment",
    "choreographic",
    "aftermath",
    "montage",
    "quiet_opening",
    "cold_open",
    "interiority",
    "environmental_pov",
    "climactic",
    "release",
    "other",
  ]),
  limit: z.number().int().min(1).max(10).default(3),
});

const OutputSchema = z.object({
  exemplars: z.array(
    z.object({
      source_turn: z.number(),
      beat_type: z.string(),
      excerpt: z.string(),
      why_it_worked: z.string().nullable(),
    }),
  ),
});

export const getVoiceExemplarsByBeatTypeTool = registerTool({
  name: "get_voice_exemplars_by_beat_type",
  description:
    "Return short prose exemplars from prior turns keyed to a specific beat type. Use when writing a similar beat and you want reference material for cadence / structure.",
  layer: "voice",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { exemplars: [] };
  },
});
