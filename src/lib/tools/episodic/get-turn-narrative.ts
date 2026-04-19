import { turns } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Pull the full narrative prose of a specific turn. Used after
 * `recall_scene` returns a hit — the hit gives you the turn number
 * and a short excerpt; this tool gives you the actual prose to weave
 * a callback from.
 */
const InputSchema = z.object({
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  turn_number: z.number(),
  player_message: z.string().nullable(),
  narrative_text: z.string().nullable(),
  intent: z.string().nullable(),
  outcome_summary: z.string().nullable(),
});

export const getTurnNarrativeTool = registerTool({
  name: "get_turn_narrative",
  description:
    "Return the full narrative prose of a specific turn, plus the player message, intent, and outcome that produced it.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({
        turn_number: turns.turnNumber,
        player_message: turns.playerMessage,
        narrative_text: turns.narrativeText,
        intent: turns.intent,
        outcome: turns.outcome,
      })
      .from(turns)
      .where(and(eq(turns.campaignId, ctx.campaignId), eq(turns.turnNumber, input.turn_number)))
      .limit(1);
    if (!row) {
      return {
        available: false,
        turn_number: input.turn_number,
        player_message: null,
        narrative_text: null,
        intent: null,
        outcome_summary: null,
      };
    }
    const intentType =
      row.intent && typeof row.intent === "object" && "intent" in row.intent
        ? String((row.intent as { intent: unknown }).intent)
        : null;
    const outcomeSummary =
      row.outcome && typeof row.outcome === "object" && "rationale" in row.outcome
        ? String((row.outcome as { rationale: unknown }).rationale)
        : null;
    return {
      available: true,
      turn_number: row.turn_number,
      player_message: row.player_message,
      narrative_text: row.narrative_text,
      intent: intentType,
      outcome_summary: outcomeSummary,
    };
  },
});
