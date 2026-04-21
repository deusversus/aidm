import { generateContextBlock } from "@/lib/agents";
import { anthropicFallbackConfig } from "@/lib/providers";
import { contextBlocks, npcs } from "@/lib/state/schema";
import { ContextBlockType } from "@/lib/types/entities";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Update (or create) a context block for a given entity. Chronicler
 * calls this when a material change to an entity's state warrants a
 * re-distillation — arc phase shift, relationship milestone,
 * significant revelation, new NPC becoming load-bearing.
 *
 * Flow:
 *   1. Check for an existing block (same campaign, block_type,
 *      entity_name). If present, treat its content as prior_version.
 *   2. Gather structured entity_data from the appropriate catalog
 *      table (npcs for "npc", plans for "arc", etc.).
 *   3. Invoke generateContextBlock with the collected context.
 *   4. Upsert: existing → version+1; new → version=1.
 *
 * This is the sole write path for context_blocks at M1. No other tool
 * should insert directly — centralizing through the generator keeps
 * content quality consistent.
 *
 * Phase 3C of v3-audit closure (docs/plans/v3-audit-closure.md §3.3).
 */

const InputSchema = z.object({
  block_type: ContextBlockType,
  entity_name: z.string().min(1),
  turn_number: z.number().int().positive(),
  /**
   * Optional extra context Chronicler wants the generator to see —
   * recent turn summaries, related semantic memories, etc. Passed
   * through to the agent untouched.
   */
  related_turns: z.array(z.string()).optional(),
  related_memories: z.array(z.string()).optional(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().min(1),
  created: z.boolean(),
});

export const updateContextBlockTool = registerTool({
  name: "update_context_block",
  description:
    "Regenerate (or first-time create) the living context block for an entity — arc / thread / quest / npc / faction / location. Fires the ContextBlockGenerator agent with the entity's structured data + related turn/memory context + the prior version (if present). Call when a material change warrants a re-distillation; the system keeps stable blocks by default.",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    // Load existing block (for prior_version) + any structured entity data.
    const [existing] = await ctx.db
      .select({
        id: contextBlocks.id,
        content: contextBlocks.content,
        continuityChecklist: contextBlocks.continuityChecklist,
        version: contextBlocks.version,
        firstTurn: contextBlocks.firstTurn,
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

    // Structured entity data by block_type. NPC blocks pull from npcs;
    // other kinds land with empty entityData at M1 (arc/quest/faction/
    // location backfill lands as those catalogs mature).
    let entityData: Record<string, unknown> = {};
    let entityId: string | null = null;
    if (input.block_type === "npc") {
      const [npc] = await ctx.db
        .select()
        .from(npcs)
        .where(and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.name, input.entity_name)))
        .limit(1);
      if (npc) {
        entityId = npc.id;
        entityData = {
          role: npc.role,
          personality: npc.personality,
          goals: npc.goals,
          secrets: npc.secrets,
          faction: npc.faction,
          visualTags: npc.visualTags,
          knowledgeTopics: npc.knowledgeTopics,
          powerTier: npc.powerTier,
          ensembleArchetype: npc.ensembleArchetype,
          firstSeenTurn: npc.firstSeenTurn,
          lastSeenTurn: npc.lastSeenTurn,
        };
      }
    }

    // Invoke the generator. modelContext defaults to Anthropic fallback
    // — Chronicler passes its own via the wrapper when this tool is
    // called through its standard flow, but direct invocation (e.g.
    // from a manual admin script) gets a sane default.
    const generated = await generateContextBlock(
      {
        blockType: input.block_type,
        entityName: input.entity_name,
        entityData,
        relatedTurns: input.related_turns ?? [],
        relatedMemories: input.related_memories ?? [],
        priorVersion: existing
          ? {
              content: existing.content,
              continuity_checklist: existing.continuityChecklist as Record<string, unknown>,
              version: existing.version,
            }
          : null,
      },
      { modelContext: anthropicFallbackConfig() },
    );

    if (existing) {
      await ctx.db
        .update(contextBlocks)
        .set({
          content: generated.content,
          continuityChecklist: generated.continuity_checklist,
          version: existing.version + 1,
          lastUpdatedTurn: input.turn_number,
          updatedAt: new Date(),
        })
        .where(eq(contextBlocks.id, existing.id));
      return { id: existing.id, version: existing.version + 1, created: false };
    }

    const [inserted] = await ctx.db
      .insert(contextBlocks)
      .values({
        campaignId: ctx.campaignId,
        blockType: input.block_type,
        entityId,
        entityName: input.entity_name,
        content: generated.content,
        continuityChecklist: generated.continuity_checklist,
        status: "active",
        version: 1,
        firstTurn: input.turn_number,
        lastUpdatedTurn: input.turn_number,
      })
      .returning({ id: contextBlocks.id });
    if (!inserted) {
      throw new Error("update_context_block: insert returned no row");
    }
    return { id: inserted.id, version: 1, created: true };
  },
});
