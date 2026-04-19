import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Plant a new foreshadowing seed in the causal graph. Invoked by
 * Director at campaign start + hybrid trigger; also usable by KA when
 * it plants something mid-scene that deserves tracking (rare, but
 * allowed). Stub until the `foreshadowing_seeds` table lands.
 */
const InputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  payoff_window_min: z.number().int().min(1),
  payoff_window_max: z.number().int().min(1),
  depends_on: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  seed_id: z.string(),
  status: z.literal("PLANTED"),
});

export const plantForeshadowingSeedTool = registerTool({
  name: "plant_foreshadowing_seed",
  description:
    "Plant a new foreshadowing seed in the causal graph. Returns the seed id for future resolve/callback references.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    // Stub: generate a unique id per call so multiple plants within a turn
    // don't collide (Director may plant several seeds in its startup
    // briefing). When the table lands, this inserts a row and returns the
    // persisted uuid.
    return {
      seed_id: `stub-${randomUUID()}`,
      status: "PLANTED" as const,
    };
  },
});
