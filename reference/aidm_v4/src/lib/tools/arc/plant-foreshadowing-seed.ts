import { foreshadowingSeeds } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Plant a new foreshadowing seed — KA entrypoint for deliberate
 * mid-scene planting. Referenced in KA's Block 1 prompt. Chronicler has
 * its own `plant_foreshadowing_candidate` for retrospective spotting;
 * both write the same PLANTED status to the same table. Two call sites,
 * one artifact.
 *
 * Director's session-boundary review (later milestone) ratifies PLANTED
 * → GROWING and eventually marks them RESOLVED or ABANDONED via
 * `resolve_seed`.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  payoff_window_min: z.number().int().min(1),
  payoff_window_max: z.number().int().min(1),
  depends_on: z.array(z.string().uuid()).default([]),
  conflicts_with: z.array(z.string().uuid()).default([]),
  planted_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  seed_id: z.string().uuid(),
  status: z.literal("PLANTED"),
});

export const plantForeshadowingSeedTool = registerTool({
  name: "plant_foreshadowing_seed",
  description:
    "Plant a new foreshadowing seed in the causal graph. Called by KA when it plants something mid-scene that deserves tracking (e.g., dropping a name that should callback later). Returns the seed id.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(foreshadowingSeeds)
      .values({
        campaignId: ctx.campaignId,
        name: input.name,
        description: input.description,
        status: "PLANTED",
        payoffWindowMin: input.payoff_window_min,
        payoffWindowMax: input.payoff_window_max,
        dependsOn: input.depends_on,
        conflictsWith: input.conflicts_with,
        plantedTurn: input.planted_turn,
      })
      .returning({ id: foreshadowingSeeds.id });
    if (!row) throw new Error("plant_foreshadowing_seed: insert returned no row");
    return { seed_id: row.id, status: "PLANTED" as const };
  },
});
