import { npcs } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Spawn a transient NPC — scene-local flavor character unlikely to
 * recur. No portrait generation, filtered out of list_known_npcs by
 * default, no relationship-event tracking. The bartender, a guard on
 * the corner, a passing sailor.
 *
 * v3-parity Phase 6A of v3-audit closure. Original v4 had only
 * register_npc, which promoted every named flavor character to catalog —
 * reopening v3's catalog-inflation failure mode. Chronicler now chooses:
 * `register_npc` for recurring figures, `spawn_transient` for one-off
 * flavor.
 *
 * Implementation: inserts into `npcs` table with is_transient=true and
 * the same unique (campaignId, name) constraint as register_npc — a
 * transient can be "upgraded" to catalog via update_npc if it
 * subsequently returns to the scene. (The reverse — demoting a catalog
 * NPC to transient — isn't currently supported; rare and ambiguous.)
 */
const InputSchema = z.object({
  name: z.string().min(1),
  /** One-line description used for rendering in scene continuity but
   * not for persistent character memory. */
  description: z.string().default(""),
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  created: z.boolean(),
});

export const spawnTransientTool = registerTool({
  name: "spawn_transient",
  description:
    "Spawn a transient (flavor) NPC — scene-local, unlikely to recur, not added to the catalog. Use for named-once characters: the bartender, a passing sailor, a guard at the door. For named recurring figures use register_npc instead.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const inserted = await ctx.db
      .insert(npcs)
      .values({
        campaignId: ctx.campaignId,
        name: input.name,
        role: "transient",
        personality: input.description,
        isTransient: true,
        firstSeenTurn: input.turn_number,
        lastSeenTurn: input.turn_number,
      })
      .onConflictDoNothing({ target: [npcs.campaignId, npcs.name] })
      .returning({ id: npcs.id });

    const [newRow] = inserted;
    if (newRow) return { id: newRow.id, created: true };

    const [existing] = await ctx.db
      .select({ id: npcs.id })
      .from(npcs)
      .where(and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.name, input.name)))
      .limit(1);
    if (!existing)
      throw new Error(`spawn_transient: insert conflict but no existing row (${input.name})`);
    return { id: existing.id, created: false };
  },
});
