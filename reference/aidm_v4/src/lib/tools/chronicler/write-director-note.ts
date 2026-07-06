import { directorNotes } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Write an advisory note KA reads in Block 4 (director_notes).
 * Chronicler uses this to nudge future turns — "Keep Faye in the frame
 * this session", "Vicious's last appearance was tense; don't undercut
 * it". Notes aren't mandatory; KA treats them as advisory.
 *
 * Scope controls lifetime:
 *   - turn: one-shot, consumed next turn then implicit-drop
 *   - session: persists through session boundary
 *   - arc: persists across sessions until arc_phase changes
 *   - campaign: sticky for the campaign's life
 * Retirement is manual — M1 lets them accumulate; M4+ may add sweeping.
 */
const InputSchema = z.object({
  content: z.string().min(1),
  scope: z.enum(["turn", "session", "arc", "campaign"]).default("session"),
  created_at_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
});

export const writeDirectorNoteTool = registerTool({
  name: "write_director_note",
  description:
    "Write an advisory director note KA reads in Block 4. Scope: turn | session | arc | campaign. Notes are advisory — not mandatory — for KA.",
  layer: "arc",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(directorNotes)
      .values({
        campaignId: ctx.campaignId,
        content: input.content,
        scope: input.scope,
        createdAtTurn: input.created_at_turn,
      })
      .returning({ id: directorNotes.id });
    if (!row) throw new Error("write_director_note: insert returned no row");
    return { id: row.id };
  },
});
