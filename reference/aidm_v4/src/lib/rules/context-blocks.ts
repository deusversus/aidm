import type { Db } from "@/lib/db";
import { contextBlocks } from "@/lib/state/schema";
import { and, desc, eq } from "drizzle-orm";

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
 * block averages ~400 tokens; per-type cap ensures no single category
 * (especially NPCs, which scale fastest) starves the others as the
 * campaign grows.
 */

const BLOCK_TYPE_ORDER = ["arc", "thread", "quest", "faction", "location", "npc"] as const;
/** Max blocks per category. Keeps the briefing balanced as the campaign
 * accumulates — 3 NPCs × 6 categories ≈ 18 blocks worst case, bounded by
 * MAX_TOTAL. Oldest-updated blocks within each category drop first. */
const PER_TYPE_CAP = 3;
/** Hard cap across all categories. ~10 × 400 tokens ≈ 4k, a ~30% overshoot
 * of the <3000 target that's acceptable given Block 2 is cache-eligible
 * and amortizes across turns within a session. */
const MAX_TOTAL = 10;

export async function assembleSessionContextBlocks(db: Db, campaignId: string): Promise<string> {
  // Pull ALL active blocks — no DB-level alphabetical order or early limit
  // (those were the Phase 3 audit MINORs: alphabetical != canonical; early
  // limit starves NPCs). In-memory sort + per-type cap is the only way to
  // preserve the canonical briefing order + prevent one category from
  // eating the budget.
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
    .orderBy(desc(contextBlocks.lastUpdatedTurn))
    .limit(500);

  if (rows.length === 0) return "";

  // Bucket by block_type and keep the PER_TYPE_CAP most-recently-updated
  // within each bucket (rows are already last-updated-desc from the DB
  // query).
  const byType = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byType.get(row.blockType) ?? [];
    if (list.length < PER_TYPE_CAP) list.push(row);
    byType.set(row.blockType, list);
  }

  // Materialize in canonical order up to MAX_TOTAL.
  const capped: typeof rows = [];
  for (const blockType of BLOCK_TYPE_ORDER) {
    const list = byType.get(blockType);
    if (!list) continue;
    for (const row of list) {
      if (capped.length >= MAX_TOTAL) break;
      capped.push(row);
    }
    if (capped.length >= MAX_TOTAL) break;
  }

  // Group for rendering (preserves canonical order because we iterated
  // over BLOCK_TYPE_ORDER above).
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
