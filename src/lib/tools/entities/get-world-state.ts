import { campaigns } from "@/lib/state/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Returns the current world state of the campaign — location, situation,
 * arc phase, tension level. Stored as a jsonb blob on `campaigns.settings`
 * and updated by commands. Safe to read without a character being
 * populated.
 *
 * Real implementation (not a stub). When the `settings` jsonb doesn't
 * yet have a `world_state` key, returns a sentinel empty shape so
 * downstream callers can rely on the schema.
 */
const InputSchema = z.object({});

const OutputSchema = z.object({
  location: z.string().nullable(),
  situation: z.string().nullable(),
  time_context: z.string().nullable(),
  arc_phase: z.string().nullable(),
  tension_level: z.number().min(0).max(1).nullable(),
  present_npcs: z.array(z.string()),
});

type OutShape = z.infer<typeof OutputSchema>;

const DEFAULT: OutShape = {
  location: null,
  situation: null,
  time_context: null,
  arc_phase: null,
  tension_level: null,
  present_npcs: [],
};

export const getWorldStateTool = registerTool({
  name: "get_world_state",
  description:
    "Return the current world state of the campaign: location, situation, arc phase, tension level, NPCs present in scene.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, ctx) => {
    const [row] = await ctx.db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, ctx.campaignId),
          eq(campaigns.userId, ctx.userId),
          isNull(campaigns.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return DEFAULT;
    const settings = (row.settings ?? {}) as {
      world_state?: Partial<OutShape>;
    };
    const ws = settings.world_state ?? {};
    return {
      location: ws.location ?? null,
      situation: ws.situation ?? null,
      time_context: ws.time_context ?? null,
      arc_phase: ws.arc_phase ?? null,
      tension_level: ws.tension_level ?? null,
      present_npcs: Array.isArray(ws.present_npcs) ? ws.present_npcs : [],
    };
  },
});
