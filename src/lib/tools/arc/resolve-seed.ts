import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Resolve an active seed as RESOLVED (paid off) or ABANDONED (plot
 * moved past it). Invoked by Director session-boundary reviews. Stub
 * until ForeshadowingLedger lands.
 */
const InputSchema = z.object({
  seed_id: z.string(),
  resolution: z.enum(["RESOLVED", "ABANDONED"]),
  reason: z.string().describe("Short justification for the resolution"),
});

const OutputSchema = z.object({
  seed_id: z.string(),
  status: z.enum(["RESOLVED", "ABANDONED"]),
});

export const resolveSeedTool = registerTool({
  name: "resolve_seed",
  description:
    "Mark a foreshadowing seed RESOLVED (paid off) or ABANDONED (plot moved past it). Irreversible; prefer ABANDONED over silent drop so the audit trail is clean.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, _ctx) => {
    return {
      seed_id: input.seed_id,
      status: input.resolution,
    };
  },
});
