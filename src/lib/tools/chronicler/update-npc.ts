import { npcs } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Update a registered NPC's fields. Chronicler calls this when a turn
 * reveals new details — personality drift, new goal, faction reveal,
 * updated last_seen_turn. All fields optional except the lookup key
 * (id XOR name). Fields omitted from the input are left unchanged.
 *
 * For jsonb array fields (goals, secrets, visual_tags), the caller
 * supplies the full new array — this tool replaces, not appends.
 * Chronicler's prompt is responsible for reading current values
 * (via get_npc_details) and passing the merged result.
 */
const InputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).optional(),
    role: z.string().optional(),
    personality: z.string().optional(),
    goals: z.array(z.string()).optional(),
    secrets: z.array(z.string()).optional(),
    faction: z.string().nullable().optional(),
    visual_tags: z.array(z.string()).optional(),
    knowledge_topics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).optional(),
    power_tier: z.string().optional(),
    ensemble_archetype: z.string().nullable().optional(),
    last_seen_turn: z.number().int().positive().optional(),
  })
  .refine((v) => v.id !== undefined || v.name !== undefined, {
    message: "Must provide either id or name as the lookup key",
  });

const OutputSchema = z.object({
  id: z.string().uuid(),
  updated: z.boolean(),
});

export const updateNpcTool = registerTool({
  name: "update_npc",
  description:
    "Update fields on an existing NPC (lookup by id or name). Omitted fields are left unchanged; jsonb arrays are replaced, not merged.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    // Drizzle's `set` ignores undefined values, but we still build the object
    // explicitly so the snake↔camel field translation is visible and tested.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.role !== undefined) patch.role = input.role;
    if (input.personality !== undefined) patch.personality = input.personality;
    if (input.goals !== undefined) patch.goals = input.goals;
    if (input.secrets !== undefined) patch.secrets = input.secrets;
    if (input.faction !== undefined) patch.faction = input.faction;
    if (input.visual_tags !== undefined) patch.visualTags = input.visual_tags;
    if (input.knowledge_topics !== undefined) patch.knowledgeTopics = input.knowledge_topics;
    if (input.power_tier !== undefined) patch.powerTier = input.power_tier;
    if (input.ensemble_archetype !== undefined) patch.ensembleArchetype = input.ensemble_archetype;
    if (input.last_seen_turn !== undefined) patch.lastSeenTurn = input.last_seen_turn;

    // Zod refinement guarantees at least one of id/name is set; narrow via
    // explicit check to avoid non-null assertions.
    const whereCond =
      input.id !== undefined
        ? and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.id, input.id))
        : input.name !== undefined
          ? and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.name, input.name))
          : undefined;
    if (!whereCond) throw new Error("update_npc: Zod refinement failed to guarantee lookup key");

    const rows = await ctx.db.update(npcs).set(patch).where(whereCond).returning({ id: npcs.id });

    const [row] = rows;
    if (!row) throw new Error(`update_npc: no NPC found (${input.id ?? input.name})`);
    return { id: row.id, updated: true };
  },
});
