import { relationshipEvents } from "@/lib/state/schema";
import { z } from "zod";
import { registerTool } from "../registry";
import { assertNpcBelongsToCampaign } from "./_npc-guard";

/**
 * Append a relationship milestone to the event log. Called by
 * RelationshipAnalyzer (Chronicler's thinking-tier consultant) when it
 * detects moments like first_trust, first_vulnerability, first_sacrifice.
 * Append-only — milestones never mutate once recorded; revisions come
 * as new events with different milestone types.
 *
 * Schema enforces milestone_type + evidence non-empty. The enum is
 * intentionally free-form at M1 so RelationshipAnalyzer can nominate new
 * types; M4+ may tighten to a closed enum once the taxonomy stabilizes.
 */
const InputSchema = z.object({
  npc_id: z.string().uuid(),
  milestone_type: z.string().min(1),
  evidence: z.string().min(1),
  turn_number: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
});

export const recordRelationshipEventTool = registerTool({
  name: "record_relationship_event",
  description:
    "Append a relationship milestone (first_trust, first_vulnerability, betrayal, etc.) to the event log. Evidence is a short prose ground for the milestone.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    // Defense-in-depth: the FK on npc_id points at npcs.id (single column),
    // so the DB won't catch a cross-campaign id by itself.
    await assertNpcBelongsToCampaign(ctx, input.npc_id, "record_relationship_event");
    const [row] = await ctx.db
      .insert(relationshipEvents)
      .values({
        campaignId: ctx.campaignId,
        npcId: input.npc_id,
        milestoneType: input.milestone_type,
        evidence: input.evidence,
        turnNumber: input.turn_number,
      })
      .returning({ id: relationshipEvents.id });
    if (!row) throw new Error("record_relationship_event: insert returned no row");
    return { id: row.id };
  },
});
