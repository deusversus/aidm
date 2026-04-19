import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return the player character's sheet for this campaign. Currently stubbed —
 * the `characters` table lands with Commit 6's seed migration. Returns a
 * typed null result so callers can probe without branching on undefined.
 *
 * When Commit 6 lands:
 *   - migration creates `characters` table keyed on campaignId
 *   - this tool queries it, returns the real sheet
 *   - the schema below is the shape KA learns to expect, so the swap is
 *     internal to execute() — downstream code doesn't change.
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

export const getCharacterSheetTool = registerTool({
  name: "get_character_sheet",
  description:
    "Return the player character's sheet: name, concept, power tier, stats, abilities, inventory, stat mapping, current state.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    // Stub until Commit 6 seeds characters. Returns a well-typed empty
    // shape — KA sees `available: false` and knows to treat character
    // details as unknown rather than absent-but-queried.
    return {
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
  },
});
