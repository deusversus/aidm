import { semanticMemories } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Write a distilled cross-turn fact to semantic memory (§9.1). Chronicler
 * calls this for facts that may matter later — "Spike owes Jet gas money",
 * "Vicious knows Julia's hiding on Callisto". Heat 0–100; KA's
 * `search_memory` ranks by relevance * heat * decay-by-category.
 *
 * Embedding stays null at M1 — the embedder decision is M4 per §9.3.
 * Read path uses tsvector + category + heat until embeddings populate.
 */
const InputSchema = z.object({
  category: z
    .string()
    .min(1)
    .describe(
      "§9.1 category: relationship | location_fact | ability_fact | lore | npc_interaction | world_state | etc. Free-form at M1; Chronicler may nominate new categories.",
    ),
  content: z.string().min(1).describe("Distilled fact in 1–3 sentences"),
  heat: z.number().int().min(0).max(100).default(100),
  turn_number: z.number().int().positive(),
  /**
   * Decay-modifying flags (§9.1 physics). plot_critical bypasses decay
   * entirely; milestone_relationship floors at 40. Use sparingly —
   * these override the category's decay curve.
   */
  flags: z
    .object({
      plot_critical: z.boolean().optional(),
      milestone_relationship: z.boolean().optional(),
      boost_priority: z.number().optional(),
    })
    .optional(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
});

export const writeSemanticMemoryTool = registerTool({
  name: "write_semantic_memory",
  description:
    "Write a distilled cross-turn fact to semantic memory. Use heat 70+ for facts central to the story, 30–60 for supporting details, <30 for context that may decay.",
  layer: "semantic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(semanticMemories)
      .values({
        campaignId: ctx.campaignId,
        category: input.category,
        content: input.content,
        heat: input.heat,
        flags: input.flags ?? {},
        turnNumber: input.turn_number,
        // embedding stays null — M4 decides embedder
      })
      .returning({ id: semanticMemories.id });
    if (!row) throw new Error("write_semantic_memory: insert returned no row");
    return { id: row.id };
  },
});
