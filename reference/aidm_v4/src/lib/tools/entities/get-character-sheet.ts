import { characters } from "@/lib/state/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return the player character's sheet for this campaign. Reads the
 * `characters` row keyed on campaignId. Returns `available: false`
 * with a typed empty shape when no character row exists (e.g. during
 * Session Zero before character creation completes).
 */
const InputSchema = z.object({});

const StatMappingSchema = z
  .object({
    system_name: z.string(),
    aliases: z.record(
      z.string(),
      z.object({
        base: z.array(z.string()),
        method: z.enum(["direct", "max", "avg", "primary"]),
      }),
    ),
    meta_resources: z.record(z.string(), z.string()),
    display_scale: z.object({ multiplier: z.number(), offset: z.number() }),
    hidden: z.array(z.string()),
    display_order: z.array(z.string()),
  })
  .nullable();

const OutputSchema = z.object({
  available: z.boolean(),
  name: z.string().nullable(),
  concept: z.string().nullable(),
  power_tier: z.string().nullable(),
  stats: z.record(z.string(), z.number()).nullable(),
  abilities: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      limitations: z.string().nullable(),
    }),
  ),
  inventory: z.array(z.object({ name: z.string(), description: z.string() })),
  stat_mapping: StatMappingSchema,
  current_state: z
    .object({
      hp: z.number().nullable(),
      status_effects: z.array(z.string()),
    })
    .nullable(),
});

const EMPTY_OUTPUT: z.infer<typeof OutputSchema> = {
  available: false,
  name: null,
  concept: null,
  power_tier: null,
  stats: null,
  abilities: [],
  inventory: [],
  stat_mapping: null,
  current_state: null,
};

export const getCharacterSheetTool = registerTool({
  name: "get_character_sheet",
  description:
    "Return the player character's sheet: name, concept, power tier, stats, abilities, inventory, stat mapping, current state.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, ctx) => {
    const [row] = await ctx.db
      .select({
        name: characters.name,
        concept: characters.concept,
        powerTier: characters.powerTier,
        sheet: characters.sheet,
      })
      .from(characters)
      .where(eq(characters.campaignId, ctx.campaignId))
      .limit(1);
    if (!row) return EMPTY_OUTPUT;

    // The sheet jsonb is whatever seed wrote. We trust the shape
    // loosely — Zod validates at the tool boundary in the registry
    // wrapper, so a malformed sheet surfaces there rather than here.
    const sheet = (row.sheet ?? {}) as Partial<z.infer<typeof OutputSchema>>;
    return {
      available: true,
      name: sheet.name ?? row.name,
      concept: sheet.concept ?? row.concept,
      power_tier: sheet.power_tier ?? row.powerTier,
      stats: sheet.stats ?? null,
      abilities: sheet.abilities ?? [],
      inventory: sheet.inventory ?? [],
      stat_mapping: sheet.stat_mapping ?? null,
      current_state: sheet.current_state ?? null,
    };
  },
});
