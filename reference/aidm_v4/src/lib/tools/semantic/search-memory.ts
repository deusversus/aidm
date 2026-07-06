import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Semantic search over distilled cross-turn memories. Queries the
 * semantic-memory layer (pgvector + category decay + heat boost). Stub
 * until the memory writer populates content. Returns an empty `memories`
 * array — KA treats that as "no relevant memory yet" rather than error.
 */
const InputSchema = z.object({
  // Either a single `query` OR an array of `queries` — caller chooses.
  // Multi-query decomposition (v3-parity Phase 7 — MINOR #19) lets KA
  // fan out 2-3 orthogonal queries ("action", "situation", "entity") and
  // merge results server-side with dedup. When M4 wires pgvector, the
  // merge happens before ranking; at M1 both shapes return empty.
  query: z.string().min(1).optional(),
  queries: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe(
      "Fan-out multi-query decomposition. Prefer 2-3 orthogonal queries over one dense query for complex scenes.",
    ),
  k: z.number().int().min(1).max(20).default(5),
  categories: z
    .array(
      z.enum([
        "core",
        "session_zero",
        "session_zero_voice",
        "relationship",
        "consequence",
        "fact",
        "npc_interaction",
        "location",
        "narrative_beat",
        "quest",
        "world_state",
        "event",
        "npc_state",
        "character_state",
        "episode",
      ]),
    )
    .optional()
    .describe("Restrict to specific memory categories (§9.1)"),
  min_heat: z.number().min(0).max(100).default(0),
});

const OutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      fragment: z.string().nullable().describe("Storyboarded prose fragment for voice recall"),
      category: z.string(),
      heat: z.number(),
      relevance: z.number(),
      created_turn: z.number(),
    }),
  ),
});

export const searchMemoryTool = registerTool({
  name: "search_memory",
  description:
    "Semantic search over distilled cross-turn memory. Returns ranked facts + their storyboarded prose fragments.",
  layer: "semantic",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, _ctx) => {
    // Require at least one query shape. Zod can't express "query OR
    // queries" cleanly, so we assert at execute time.
    if (!input.query && (!input.queries || input.queries.length === 0)) {
      throw new Error(
        "search_memory: must supply either `query` (single) or `queries` (array). Both absent.",
      );
    }
    // Retrieval runtime is M4-gated (embedder decision). Returns empty
    // until pgvector + MemoryRanker land. When that happens, this
    // execute branch will:
    //   1. Run each query through embedding → pgvector cosine top-k.
    //   2. Merge candidates across queries; dedupe on content-prefix.
    //   3. Apply STATIC_BOOST (session_zero/plot_critical +0.3; episode +0.15).
    //   4. Pass through MemoryRanker for final rerank.
    //   5. Apply boostHeatOnAccess to each returned id.
    return { memories: [] };
  },
});
