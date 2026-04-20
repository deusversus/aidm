import { locations } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new location in the campaign's catalog. No-op on conflict
 * (campaignId, name). `details` is a free-form jsonb — description,
 * notable features, faction ownership, etc. shape firms up as profiles
 * mature. Chronicler calls this post-turn for every named place KA
 * introduced; re-calls are safe (idempotent by name).
 */
const InputSchema = z.object({
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  first_seen_turn: z.number().int().positive(),
  last_seen_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  created: z.boolean(),
});

export const registerLocationTool = registerTool({
  name: "register_location",
  description:
    "Register a new location in the campaign's catalog. No-op if a location with this name already exists. Returns the location id.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const inserted = await ctx.db
      .insert(locations)
      .values({
        campaignId: ctx.campaignId,
        name: input.name,
        details: input.details ?? {},
        firstSeenTurn: input.first_seen_turn,
        lastSeenTurn: input.last_seen_turn,
      })
      .onConflictDoNothing({ target: [locations.campaignId, locations.name] })
      .returning({ id: locations.id });

    const [newRow] = inserted;
    if (newRow) return { id: newRow.id, created: true };

    const [existing] = await ctx.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.campaignId, ctx.campaignId), eq(locations.name, input.name)))
      .limit(1);
    if (!existing)
      throw new Error(`register_location: insert conflict but no existing row (${input.name})`);
    return { id: existing.id, created: false };
  },
});
