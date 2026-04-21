import type { Db } from "@/lib/db";
import { contextBlocks } from "@/lib/state/schema";
import { and, asc, eq } from "drizzle-orm";

/**
 * Read-path helper for context_blocks (Phase 3C of v3-audit closure).
 *
 * assembleSessionContextBlocks pulls all `active` blocks for a campaign
 * and renders them as a Markdown bundle for Block 2 of KA's systemPrompt.
 * Block 2 is semi-static (invalidates on any block update); the bundle
 * is the "session-start briefing" KA reads before scene one.
 *
 * Ordering:
 *   arc → thread → quest → faction → location → npc
 * so the broad-stroke narrative context comes first and character-level
 * detail follows. Stable across turns within a session.
 *
 * Budget: target <3000 tokens total per plan §3 Phase audit focus. Each
 * block averages ~400 tokens; this accommodates 6-7 active blocks. If
 * the campaign has more, the assembler caps at ~10 blocks prioritized
 * by the ordering above (oldest-updated drops first within a type).
 */

const BLOCK_TYPE_ORDER = ["arc", "thread", "quest", "faction", "location", "npc"] as const;
const MAX_BLOCKS = 10;

export async function assembleSessionContextBlocks(db: Db, campaignId: string): Promise<string> {
  const rows = await db
    .select({
      blockType: contextBlocks.blockType,
      entityName: contextBlocks.entityName,
      content: contextBlocks.content,
      continuityChecklist: contextBlocks.continuityChecklist,
      lastUpdatedTurn: contextBlocks.lastUpdatedTurn,
    })
    .from(contextBlocks)
    .where(and(eq(contextBlocks.campaignId, campaignId), eq(contextBlocks.status, "active")))
    .orderBy(asc(contextBlocks.blockType), asc(contextBlocks.entityName))
    .limit(MAX_BLOCKS * 2);

  if (rows.length === 0) return "";

  // Sort by canonical type order, then by most-recently-updated.
  const orderIndex = (t: string) => {
    const i = BLOCK_TYPE_ORDER.indexOf(t as (typeof BLOCK_TYPE_ORDER)[number]);
    return i === -1 ? BLOCK_TYPE_ORDER.length : i;
  };
  rows.sort((a, b) => {
    const diff = orderIndex(a.blockType) - orderIndex(b.blockType);
    if (diff !== 0) return diff;
    return b.lastUpdatedTurn - a.lastUpdatedTurn;
  });

  const capped = rows.slice(0, MAX_BLOCKS);

  // Group by block_type; render sections.
  const grouped = new Map<string, typeof capped>();
  for (const row of capped) {
    const list = grouped.get(row.blockType) ?? [];
    list.push(row);
    grouped.set(row.blockType, list);
  }

  const sections: string[] = [];
  for (const blockType of BLOCK_TYPE_ORDER) {
    const list = grouped.get(blockType);
    if (!list || list.length === 0) continue;
    const heading = sectionHeading(blockType);
    const body = list
      .map((b) => {
        const checklist = formatChecklist(b.continuityChecklist as Record<string, unknown>);
        return `#### ${b.entityName}\n\n${b.content.trim()}${checklist ? `\n\n${checklist}` : ""}`;
      })
      .join("\n\n");
    sections.push(`### ${heading}\n\n${body}`);
  }

  return sections.join("\n\n---\n\n");
}

function sectionHeading(blockType: string): string {
  switch (blockType) {
    case "arc":
      return "Current arc";
    case "thread":
      return "Active threads";
    case "quest":
      return "Active quests";
    case "npc":
      return "NPCs in play";
    case "faction":
      return "Factions in play";
    case "location":
      return "Active locations";
    default:
      return blockType;
  }
}

function formatChecklist(checklist: Record<string, unknown>): string {
  const keys = Object.keys(checklist);
  if (keys.length === 0) return "";
  const lines = keys.map((k) => `  - ${k}: ${JSON.stringify(checklist[k])}`);
  return `**Continuity**\n${lines.join("\n")}`;
}
