import { z } from "zod";
import { registerTool } from "../registry";

/**
 * List foreshadowing seeds that are PLANTED, GROWING, or CALLBACK-ready.
 * KA consults when deciding whether this beat wants to surface a seed.
 * Stub until the ForeshadowingLedger subsystem lands.
 */
const InputSchema = z.object({
  include_overdue: z
    .boolean()
    .default(true)
    .describe("Include seeds past payoff_window_max as OVERDUE"),
});

const OutputSchema = z.object({
  seeds: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      status: z.enum(["PLANTED", "GROWING", "CALLBACK", "RESOLVED", "ABANDONED", "OVERDUE"]),
      planted_turn: z.number(),
      payoff_window: z.object({ min: z.number(), max: z.number() }),
      depends_on: z.array(z.string()),
      conflicts_with: z.array(z.string()),
    }),
  ),
});

export const listActiveSeedsTool = registerTool({
  name: "list_active_seeds",
  description:
    "List foreshadowing seeds still active (PLANTED / GROWING / CALLBACK / OVERDUE). Use when deciding whether this beat should surface an existing seed.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return { seeds: [] };
  },
});
