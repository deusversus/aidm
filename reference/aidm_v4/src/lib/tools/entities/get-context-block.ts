import { contextBlocks } from "@/lib/state/schema";
import { ContextBlockType } from "@/lib/types/entities";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Fetch a single context block by (block_type, entity_name). Rare in
 * practice — KA reads the full active-block bundle at session start via
 * Block 2 rendering, so this tool is for mid-scene "I need the full
 * picture on this NPC right now" moments.
 *
 * Returns null if no block exists (fresh campaigns before Chronicler
 * has generated anything, or entities KA is meeting for the first
 * time). Graceful absent.
 */
const InputSchema = z.object({
  block_type: ContextBlockType,
  entity_name: z.string().min(1),
});

const OutputSchema = z
  .object({
    content: z.string(),
    continuity_checklist: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    status: z.enum(["active", "closed", "archived"]),
    last_updated_turn: z.number().int(),
  })
  .nullable();

export const getContextBlockTool = registerTool({
  name: "get_context_block",
  description:
    "Fetch the living context block for a specific entity (arc | thread | quest | npc | faction | location) by name. Returns null if no block exists yet. Use when you need the full picture on this entity mid-scene; the session-start bundle already includes active blocks.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({
        content: contextBlocks.content,
        continuityChecklist: contextBlocks.continuityChecklist,
        version: contextBlocks.version,
        status: contextBlocks.status,
        lastUpdatedTurn: contextBlocks.lastUpdatedTurn,
      })
      .from(contextBlocks)
      .where(
        and(
          eq(contextBlocks.campaignId, ctx.campaignId),
          eq(contextBlocks.blockType, input.block_type),
          eq(contextBlocks.entityName, input.entity_name),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      content: row.content,
      continuity_checklist: row.continuityChecklist as Record<string, unknown>,
      version: row.version,
      status: row.status,
      last_updated_turn: row.lastUpdatedTurn,
    };
  },
});
