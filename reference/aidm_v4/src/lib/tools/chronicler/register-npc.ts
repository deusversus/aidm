import { npcs } from "@/lib/state/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { registerTool } from "../registry";

/**
 * Register a new NPC in the campaign's catalog. Chronicler calls this
 * post-turn when it detects a named character that isn't yet in `npcs`.
 * No-op on conflict (campaignId, name) — existing entries are updated
 * via `update_npc` instead of clobbered. Returns the id either way so
 * downstream tools (record_relationship_event) can reference it.
 *
 * Matches v3 WorldBuilder NPCDetails shape. Fields left unset get the
 * column defaults (role=acquaintance, power_tier=T10, empty arrays).
 */
const InputSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  personality: z.string().optional(),
  goals: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  faction: z.string().nullable().optional(),
  visual_tags: z.array(z.string()).optional(),
  knowledge_topics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).optional(),
  power_tier: z.string().optional(),
  ensemble_archetype: z.string().nullable().optional(),
  first_seen_turn: z.number().int().positive(),
  last_seen_turn: z.number().int().positive(),
});

const OutputSchema = z.object({
  id: z.string().uuid(),
  created: z
    .boolean()
    .describe("True if a new row was inserted; false if (campaignId, name) already existed"),
});

export const registerNpcTool = registerTool({
  name: "register_npc",
  description:
    "Register a new NPC in the campaign's catalog. No-op if an NPC with this name already exists — use update_npc to change fields. Returns the NPC id for downstream references (relationship events, spotlight debt).",
  layer: "entities",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    // Try insert; on conflict return the existing id.
    const inserted = await ctx.db
      .insert(npcs)
      .values({
        campaignId: ctx.campaignId,
        name: input.name,
        role: input.role ?? "acquaintance",
        personality: input.personality ?? "",
        goals: input.goals ?? [],
        secrets: input.secrets ?? [],
        faction: input.faction ?? null,
        visualTags: input.visual_tags ?? [],
        knowledgeTopics: input.knowledge_topics ?? {},
        powerTier: input.power_tier ?? "T10",
        ensembleArchetype: input.ensemble_archetype ?? null,
        firstSeenTurn: input.first_seen_turn,
        lastSeenTurn: input.last_seen_turn,
      })
      .onConflictDoNothing({ target: [npcs.campaignId, npcs.name] })
      .returning({ id: npcs.id });

    const [newRow] = inserted;
    if (newRow) return { id: newRow.id, created: true };

    // Conflict: fetch the existing id so Chronicler can still hand it downstream.
    const [existing] = await ctx.db
      .select({ id: npcs.id })
      .from(npcs)
      .where(and(eq(npcs.campaignId, ctx.campaignId), eq(npcs.name, input.name)))
      .limit(1);
    if (!existing)
      throw new Error(`register_npc: insert conflict but no existing row (${input.name})`);
    return { id: existing.id, created: false };
  },
});
