import { arcPlanHistory } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Append a new row to `arc_plan_history` — the append-only audit trail
 * of Director's arc decisions. Latest row per campaign is the current
 * state; older rows preserve how the arc evolved. Chronicler writes on
 * hybrid triggers (every 3+ turns at epicness ≥ 0.6) or session
 * boundaries when arc_mode / arc_phase should shift based on what
 * happened in recent turns.
 *
 * Tension level is 0.0–1.0; phase and mode use the schema's closed
 * enums. `planned_beats` is an advisory array KA reads in Block 4 —
 * not a script, not prescriptive past the next 1–3 turns.
 */
const InputSchema = z.object({
  current_arc: z.string().min(1).describe("Short name for the active arc"),
  arc_phase: z.enum(["setup", "development", "complication", "crisis", "resolution"]),
  arc_mode: z.enum([
    "main_arc",
    "ensemble_arc",
    "adversary_ensemble_arc",
    "ally_ensemble_arc",
    "investigator_arc",
    "faction_arc",
  ]),
  planned_beats: z.array(z.string()).default([]),
  tension_level: z.number().min(0).max(1),
  set_at_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  set_at_turn: z.number().int().positive(),
});

export const updateArcPlanTool = registerTool({
  name: "update_arc_plan",
  description:
    "Append a new arc-plan snapshot (phase, mode, beats, tension). Latest row per campaign is the active arc state. Fire on hybrid triggers or session boundaries.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(arcPlanHistory)
      .values({
        campaignId: ctx.campaignId,
        currentArc: input.current_arc,
        arcPhase: input.arc_phase,
        arcMode: input.arc_mode,
        plannedBeats: input.planned_beats,
        // numeric column — Drizzle accepts a string at this precision
        tensionLevel: input.tension_level.toFixed(2),
        setAtTurn: input.set_at_turn,
      })
      .returning({ id: arcPlanHistory.id, setAtTurn: arcPlanHistory.setAtTurn });
    if (!row) throw new Error("update_arc_plan: insert returned no row");
    return { id: row.id, set_at_turn: row.setAtTurn };
  },
});
