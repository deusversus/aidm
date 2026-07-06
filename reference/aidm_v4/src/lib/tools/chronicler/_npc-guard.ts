import { npcs } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import type { AidmToolContext } from "../types";

/**
 * Cross-campaign FK integrity guard. The FK on `npc_id` columns points
 * at `npcs.id` (single-column), so the DB happily accepts an NPC id
 * belonging to a *different* campaign owned by the same or different
 * user. `authorizeCampaignAccess` has already proven the caller owns
 * `ctx.campaignId`, but a hallucinated `npc_id` from another campaign
 * would silently land in the wrong table without this pre-write guard.
 *
 * Cheap (single indexed lookup on `npcs_campaign_name_key` fallback to
 * pk), so every write tool that accepts an `npc_id` calls this.
 */
export async function assertNpcBelongsToCampaign(
  ctx: Pick<AidmToolContext, "db" | "campaignId">,
  npcId: string,
  toolName: string,
): Promise<void> {
  const [row] = await ctx.db
    .select({ id: npcs.id })
    .from(npcs)
    .where(and(eq(npcs.id, npcId), eq(npcs.campaignId, ctx.campaignId)))
    .limit(1);
  if (!row) {
    throw new Error(`${toolName}: npc_id ${npcId} not found in this campaign`);
  }
}
