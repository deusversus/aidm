import { factions } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new faction (organization, syndicate, government, etc.)
 * in the campaign's catalog. No-op on conflict (campaignId, name).
 * `details` is free-form jsonb — goals, leadership, member NPCs by
 * name, etc. Chronicler calls this when KA introduces an organization
 * that isn't already catalogued.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  created: z.boolean(),
});

export const registerFactionTool = registerTool({
  name: "register_faction",
  description:
    "Register a new faction in the campaign's catalog. No-op if a faction with this name already exists. Returns the faction id.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const inserted = await ctx.db
      .insert(factions)
      .values({
        campaignId: ctx.campaignId,
        name: input.name,
        details: input.details ?? {},
      })
      .onConflictDoNothing({ target: [factions.campaignId, factions.name] })
      .returning({ id: factions.id });

    const [newRow] = inserted;
    if (newRow) return { id: newRow.id, created: true };

    const [existing] = await ctx.db
      .select({ id: factions.id })
      .from(factions)
      .where(and(eq(factions.campaignId, ctx.campaignId), eq(factions.name, input.name)))
      .limit(1);
    if (!existing)
      throw new Error(`register_faction: insert conflict but no existing row (${input.name})`);
    return { id: existing.id, created: false };
  },
});
