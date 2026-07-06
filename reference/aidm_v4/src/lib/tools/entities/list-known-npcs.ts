import { npcs } from "@/lib/state/schema";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * List every catalog NPC in this campaign with a brief summary.
 *
 * Phase 6A of v3-audit closure: transient NPCs (spawn_transient) are
 * excluded from this view by default because they're scene-local flavor
 * and would drown the catalog. Pass `include_transient: true` to get
 * everyone (rare; useful for debugging or admin views).
 *
 * Affinity is not currently tracked as a numeric column — returns 0 as
 * a placeholder until relationship-events aggregate into a score (M4).
 */
const InputSchema = z.object({
  include_transient: z.boolean().default(false),
});

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
    "List catalog NPCs in this campaign with id, name, role, brief summary. Excludes transients (flavor characters) by default; pass include_transient=true to see all.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const whereClause = input.include_transient
      ? eq(npcs.campaignId, ctx.campaignId)
      : and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.isTransient, false));
    const rows = await ctx.db
      .select({
        id: npcs.id,
        name: npcs.name,
        role: npcs.role,
        personality: npcs.personality,
      })
      .from(npcs)
      .where(whereClause)
      .orderBy(asc(npcs.name))
      .limit(200);
    return {
      npcs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        brief: r.personality || "(no personality inferred yet)",
        // Affinity placeholder — M4 aggregates from relationship_events.
        affinity: 0,
      })),
    };
  },
});
