import { turns } from "@/lib/state/schema";
import { and, between, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Keyword / tsvector search over turn transcripts. Returns the turn
 * numbers whose narrative prose matches the query, with a short excerpt
 * for disambiguation. KA uses this to reach back for specific prior
 * scenes — "the fight with Vicious" — and then pulls the full prose via
 * `get_turn_narrative`.
 *
 * Implementation: `plainto_tsquery('english', $1)` against the
 * generated `narrative_tsv` column. `ts_headline` produces a ~200-char
 * excerpt around matched terms.
 */
const InputSchema = z.object({
  keyword: z.string().min(1).describe("Phrase or keyword to match against narrative prose"),
  turn_range: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .optional()
    .describe("Optional turn-number window to restrict the search"),
  limit: z.number().int().min(1).max(20).default(5),
});

const OutputSchema = z.object({
  hits: z.array(
    z.object({
      turn: z.number(),
      score: z.number(),
      excerpt: z.string(),
    }),
  ),
});

export const recallSceneTool = registerTool({
  name: "recall_scene",
  description:
    "Keyword / tsvector search over the campaign's turn transcripts. Returns matching turn numbers with short prose excerpts. Use get_turn_narrative to pull a full turn after a hit.",
  layer: "episodic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const whereClauses = [eq(turns.campaignId, ctx.campaignId)];
    if (input.turn_range?.min !== undefined && input.turn_range?.max !== undefined) {
      whereClauses.push(between(turns.turnNumber, input.turn_range.min, input.turn_range.max));
    } else if (input.turn_range?.min !== undefined) {
      whereClauses.push(sql`${turns.turnNumber} >= ${input.turn_range.min}`);
    } else if (input.turn_range?.max !== undefined) {
      whereClauses.push(sql`${turns.turnNumber} <= ${input.turn_range.max}`);
    }

    // plainto_tsquery handles arbitrary user text safely.
    const tsquery = sql`plainto_tsquery('english', ${input.keyword})`;
    whereClauses.push(sql`narrative_tsv @@ ${tsquery}`);

    const rows = await ctx.db
      .select({
        turn: turns.turnNumber,
        score: sql<number>`ts_rank(narrative_tsv, ${tsquery})`,
        excerpt: sql<string>`ts_headline('english', ${turns.narrativeText}, ${tsquery}, 'MaxWords=35, MinWords=10')`,
      })
      .from(turns)
      .where(and(...whereClauses))
      .orderBy(desc(sql`ts_rank(narrative_tsv, ${tsquery})`))
      .limit(input.limit);

    return {
      hits: rows.map((r) => ({
        turn: r.turn,
        score: Number(r.score),
        excerpt: r.excerpt,
      })),
    };
  },
});
