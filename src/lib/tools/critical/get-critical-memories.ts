import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return the plot-critical / SZ / never-decay subset of semantic memory.
 * Always-on: if a memory is flagged plot_critical, it surfaces here
 * regardless of heat or recency.
 *
 * This tool lives in both `aidm-semantic` and `aidm-critical` MCP
 * servers — semantic exposes it as "always-present memories," critical
 * exposes it as "the sacred set." Same implementation, two discovery
 * surfaces.
 *
 * Stub until the memory writer (M4) flags the first plot-critical
 * memories.
 */
const InputSchema = z.object({});

const OutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      fragment: z.string().nullable(),
      category: z.string(),
      created_turn: z.number(),
      flags: z.array(z.string()),
    }),
  ),
});

export const getCriticalMemoriesTool = registerTool({
  name: "get_critical_memories",
  description:
    "Return plot-critical and Session Zero memories — the subset that never decays and is always relevant.",
  layer: "critical",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { memories: [] };
  },
});
