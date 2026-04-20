import { foreshadowingSeeds } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Ratify a Chronicler-planted candidate into a Director-sanctioned seed.
 * Transition: PLANTED → GROWING. Called by Director during session-
 * boundary reviews when a PLANTED candidate is worth tracking as part
 * of the active arc's causal graph. Fails if the seed isn't currently
 * PLANTED (idempotent-ish: double-ratify surfaces as error).
 *
 * Director landing is post-M1; we ship the tool now because plan §7.2
 * enumerates it as a 7.2 deliverable. The write path is exercised in
 * this commit; the orchestrator that calls it lands later.
 */
const InputSchema = z.object({
  seed_id: z.string().uuid(),
});

const OutputSchema = z.object({
  seed_id: z.string().uuid(),
  status: z.literal("GROWING"),
});

export const ratifyForeshadowingSeedTool = registerTool({
  name: "ratify_foreshadowing_seed",
  description:
    "Ratify a PLANTED foreshadowing seed into GROWING status — Director session-boundary review. Fails if the seed isn't currently PLANTED.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const rows = await ctx.db
      .update(foreshadowingSeeds)
      .set({ status: "GROWING", updatedAt: new Date() })
      .where(
        and(
          eq(foreshadowingSeeds.campaignId, ctx.campaignId),
          eq(foreshadowingSeeds.id, input.seed_id),
          eq(foreshadowingSeeds.status, "PLANTED"),
        ),
      )
      .returning({ id: foreshadowingSeeds.id });
    const [row] = rows;
    if (!row) {
      throw new Error(
        `ratify_foreshadowing_seed: no PLANTED seed found for id ${input.seed_id} (may already be ratified, resolved, or belong to another campaign)`,
      );
    }
    return { seed_id: row.id, status: "GROWING" as const };
  },
});
