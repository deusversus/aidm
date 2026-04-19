import { z } from "zod";
import { registerTool } from "../registry";

/**
 * List every NPC catalogued in this campaign with a brief summary. Stub
 * until the `npcs` table lands. Returns an empty array — a valid
 * state for campaigns that haven't catalogued anyone yet.
 */
const InputSchema = z.object({});

const OutputSchema = z.object({
  npcs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string().nullable(),
      brief: z.string(),
      affinity: z.number(),
    }),
  ),
});

export const listKnownNpcsTool = registerTool({
  name: "list_known_npcs",
  description:
    "List every NPC catalogued in this campaign with id, name, role, brief summary, current affinity.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { npcs: [] };
  },
});
