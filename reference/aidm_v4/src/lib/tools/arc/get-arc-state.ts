import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Return the current arc state: current arc, phase, mode, pov, tension,
 * transition signal KA should watch for. Populated by Director at
 * campaign startup + session boundaries + hybrid trigger. Stub until
 * Director runs.
 */
const InputSchema = z.object({});

const OutputSchema = z.object({
  available: z.boolean(),
  current_arc: z.string().nullable(),
  arc_phase: z.enum(["setup", "development", "complication", "crisis", "resolution"]).nullable(),
  arc_mode: z
    .enum([
      "main_arc",
      "ensemble_arc",
      "adversary_ensemble_arc",
      "ally_ensemble_arc",
      "investigator_arc",
      "faction_arc",
    ])
    .nullable(),
  arc_pov_protagonist: z.string().nullable(),
  arc_transition_signal: z.string().nullable(),
  tension_level: z.number().min(0).max(1).nullable(),
  planned_beats: z.array(z.string()),
});

export const getArcStateTool = registerTool({
  name: "get_arc_state",
  description:
    "Return current arc plan: arc name, phase, mode, pov, tension level, planned beats, and the prose event whose occurrence closes the current arc mode.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (_input, _ctx) => {
    return {
      available: false,
      current_arc: null,
      arc_phase: null,
      arc_mode: null,
      arc_pov_protagonist: null,
      arc_transition_signal: null,
      tension_level: null,
      planned_beats: [],
    };
  },
});
