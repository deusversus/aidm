import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Full NPC profile: disposition, emotional milestones, secrets, faction
 * ties, recent interactions. Stub until the `npcs` catalog populates
 * (M4+). Returns `available: false` with an empty shape so KA can probe
 * a name and know whether the NPC is catalog-known yet.
 */
const InputSchema = z.object({
  npc_id: z.string().describe("The NPC's catalog id or name"),
});

const OutputSchema = z.object({
  available: z.boolean(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  disposition: z
    .object({
      affinity: z.number(),
      trust: z.number(),
      notes: z.string().nullable(),
    })
    .nullable(),
  emotional_milestones: z.array(
    z.object({
      type: z.string(),
      triggering_moment: z.string(),
      turn: z.number(),
    }),
  ),
  secrets: z.array(z.string()),
  faction_ties: z.array(z.string()),
  recent_interactions: z.array(z.object({ turn: z.number(), summary: z.string() })),
  visual_tags: z.array(z.string()),
  power_tier: z.string().nullable(),
});

export const getNpcDetailsTool = registerTool({
  name: "get_npc_details",
  description:
    "Return an NPC's full profile: disposition, emotional milestones, secrets, faction ties, recent interactions, visual tags, power tier.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return {
      available: false,
      id: null,
      name: null,
      role: null,
      disposition: null,
      emotional_milestones: [],
      secrets: [],
      faction_ties: [],
      recent_interactions: [],
      visual_tags: [],
      power_tier: null,
    };
  },
});
