import { foreshadowingSeeds } from "@/lib/state/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Retire an active foreshadowing seed as ABANDONED — plot moved past it,
 * character who'd pay it off died, Director's session review decided
 * not to pursue. Accepts PLANTED, GROWING, or CALLBACK seeds; rejects
 * already-RESOLVED / ABANDONED / OVERDUE (the state machine's terminal
 * states).
 *
 * Distinct from `resolve_seed` — which covers both RESOLVED (payoff)
 * and ABANDONED (skipped). `retire_foreshadowing_seed` is the explicit
 * ABANDONED entry point Director uses during session reviews.
 */
const InputSchema = z.object({
  seed_id: z.string().uuid(),
  reason: z.string().optional().describe("Short justification; not persisted at M1 (logged only)"),
});

const OutputSchema = z.object({
  seed_id: z.string().uuid(),
  status: z.literal("ABANDONED"),
});

export const retireForeshadowingSeedTool = registerTool({
  name: "retire_foreshadowing_seed",
  description:
    "Mark an active foreshadowing seed ABANDONED. Fails if the seed is already terminal (RESOLVED, ABANDONED, OVERDUE).",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const rows = await ctx.db
      .update(foreshadowingSeeds)
      .set({ status: "ABANDONED", updatedAt: new Date() })
      .where(
        and(
          eq(foreshadowingSeeds.campaignId, ctx.campaignId),
          eq(foreshadowingSeeds.id, input.seed_id),
          inArray(foreshadowingSeeds.status, ["PLANTED", "GROWING", "CALLBACK"]),
        ),
      )
      .returning({ id: foreshadowingSeeds.id });
    const [row] = rows;
    if (!row) {
      throw new Error(
        `retire_foreshadowing_seed: no active seed found for id ${input.seed_id} (may already be terminal or belong to another campaign)`,
      );
    }
    return { seed_id: row.id, status: "ABANDONED" as const };
  },
});
