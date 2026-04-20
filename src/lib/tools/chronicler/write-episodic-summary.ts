import { turns } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Populate `turns.summary` for a just-completed turn. Chronicler calls
 * this once per turn with a tight 1–3 sentence distillation of what
 * happened — the handle KA uses during working-memory recall when the
 * full narrative is too big to fit.
 *
 * Idempotent: safe to re-run on a turn whose summary already exists
 * (overwrites). FIFO-per-campaign ordering in 7.4 ensures Chronicler
 * runs once per turn in turn-number order.
 */
const InputSchema = z.object({
  turn_number: z.number().int().positive(),
  summary: z.string().min(1),
});

const OutputSchema = z.object({
  turn_number: z.number().int().positive(),
  updated: z.boolean(),
});

export const writeEpisodicSummaryTool = registerTool({
  name: "write_episodic_summary",
  description:
    "Populate the 1–3 sentence summary for a completed turn. Overwrites existing summary if present.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const rows = await ctx.db
      .update(turns)
      .set({ summary: input.summary })
      .where(and(eq(turns.campaignId, ctx.campaignId), eq(turns.turnNumber, input.turn_number)))
      .returning({ turnNumber: turns.turnNumber });
    const [row] = rows;
    if (!row) {
      throw new Error(`write_episodic_summary: no turn row found for turn ${input.turn_number}`);
    }
    return { turn_number: row.turnNumber, updated: true };
  },
});
