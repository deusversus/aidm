import { spotlightDebt } from "@/lib/state/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";
import { assertNpcBelongsToCampaign } from "./_npc-guard";

/**
 * Adjust an NPC's spotlight debt by `delta`. Negative debt = NPC is
 * underexposed (Director should pull them in); positive = recently
 * on-screen (Director should rest them). Director consults this when
 * choosing arc_mode (ensemble_arc vs main_arc). One row per (campaign,
 * npc) — upsert on conflict with `debt = debt + delta`.
 *
 * Chronicler calls per-turn: + for NPCs who were in the scene, – for
 * NPCs who sat out. Magnitude tunable; M1 default is ±1 per turn per
 * NPC with Director-level nudges allowed.
 */
const InputSchema = z.object({
  npc_id: z.string().uuid(),
  delta: z.number().int(),
  updated_at_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  npc_id: z.string().uuid(),
  debt: z.number().int(),
});

export const adjustSpotlightDebtTool = registerTool({
  name: "adjust_spotlight_debt",
  description:
    "Adjust spotlight debt for an NPC by a signed delta. Positive = recently on-screen; negative = underexposed. Upserts on (campaign, npc).",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    await assertNpcBelongsToCampaign(ctx, input.npc_id, "adjust_spotlight_debt");
    const [row] = await ctx.db
      .insert(spotlightDebt)
      .values({
        campaignId: ctx.campaignId,
        npcId: input.npc_id,
        debt: input.delta,
        updatedAtTurn: input.updated_at_turn,
      })
      .onConflictDoUpdate({
        target: [spotlightDebt.campaignId, spotlightDebt.npcId],
        set: {
          debt: sql`${spotlightDebt.debt} + ${input.delta}`,
          updatedAtTurn: input.updated_at_turn,
        },
      })
      .returning({ npcId: spotlightDebt.npcId, debt: spotlightDebt.debt });

    if (!row) throw new Error("adjust_spotlight_debt: upsert returned no row");
    return { npc_id: row.npcId, debt: row.debt };
  },
});
