import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { canonChunks, episodicRecords } from "@/lib/db/schema";
import { embedTexts } from "@/lib/llm/voyage";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

/**
 * The KA's Phase-B research tools (blueprint §5.1 contracts: ≤2 genga /
 * ≤4 sakuga / 0 douga; §5.6: these round-trips are the GUARANTEED
 * within-turn cache reads). C7's Director investigation reuses the recall
 * tools. Results are compact — research informs the pen, it never floods it.
 */

export const SEARCH_LORE_TOOL: Tool = {
  name: "search_lore",
  description:
    "Search the canon lore corpus (wiki-derived, source-tagged) for world facts: characters, techniques, locations, factions, events. Use when the scene touches canon you are not sure of — a wrong canon detail breaks the superfan's trust.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "what you need to know" },
      page_type: {
        type: "string",
        description:
          "optional filter: characters | techniques | locations | factions | items | events",
      },
    },
    required: ["query"],
  },
};

export const RECALL_SCENE_TOOL: Tool = {
  name: "recall_scene",
  description:
    "Recall the full verbatim record of a specific past turn (player input + narration). Use when you need the exact texture of a moment — wording, beats, who said what.",
  input_schema: {
    type: "object",
    properties: {
      turn_number: { type: "number", description: "the turn to recall" },
    },
    required: ["turn_number"],
  },
};

export const GET_TURN_NARRATIVE_TOOL: Tool = {
  name: "get_turn_narrative",
  description:
    "Fetch the narration text of a RANGE of past turns (compact, narration only). Use for continuity across a stretch — how a thread developed, what tone a location carried.",
  input_schema: {
    type: "object",
    properties: {
      from_turn: { type: "number" },
      to_turn: { type: "number" },
    },
    required: ["from_turn", "to_turn"],
  },
};

export const KA_RESEARCH_TOOLS: Tool[] = [
  SEARCH_LORE_TOOL,
  RECALL_SCENE_TOOL,
  GET_TURN_NARRATIVE_TOOL,
];

export async function executeSearchLore(
  db: Db,
  profileIds: string[],
  input: { query: string; page_type?: string },
  ctx: { campaignId?: string; turnNumber?: number } = {},
): Promise<string> {
  if (profileIds.length === 0) return "No canon corpus loaded for this campaign.";
  const [emb] = await embedTexts([input.query], {
    inputType: "query",
    patience: "interactive",
    campaignId: ctx.campaignId,
    turnNumber: ctx.turnNumber,
  });
  if (!emb) return "Lore search unavailable (embedding failed) — write from what you have.";
  const vec = `[${emb.join(",")}]`;
  const rows = await db
    .select({
      title: canonChunks.title,
      pageType: canonChunks.pageType,
      profileId: canonChunks.profileId,
      content: canonChunks.content,
    })
    .from(canonChunks)
    .where(
      and(
        inArray(canonChunks.profileId, profileIds),
        notTombstoned(canonChunks),
        ...(input.page_type ? [eq(canonChunks.pageType, input.page_type)] : []),
      ),
    )
    .orderBy(sql`${canonChunks.embedding} <=> ${vec}::vector`)
    .limit(3);
  if (rows.length === 0) return "No canon found for that query.";
  return rows
    .map((r) => `[${r.profileId}/${r.pageType}] ${r.title ?? ""}\n${r.content.slice(0, 900)}`)
    .join("\n\n---\n\n");
}

export async function executeRecallScene(
  db: Db,
  campaignId: string,
  input: { turn_number: number },
): Promise<string> {
  const [row] = await db
    .select()
    .from(episodicRecords)
    .where(
      and(
        eq(episodicRecords.campaignId, campaignId),
        eq(episodicRecords.turnNumber, input.turn_number),
        notTombstoned(episodicRecords),
      ),
    );
  if (!row) return `No record of turn ${input.turn_number}.`;
  return `[Turn ${row.turnNumber}]\nPlayer: ${row.playerInput}\n\n${row.narration}`;
}

export async function executeGetTurnNarrative(
  db: Db,
  campaignId: string,
  input: { from_turn: number; to_turn: number },
): Promise<string> {
  const from = Math.min(input.from_turn, input.to_turn);
  const to = Math.min(Math.max(input.from_turn, input.to_turn), from + 12);
  const rows = await db
    .select({ turnNumber: episodicRecords.turnNumber, narration: episodicRecords.narration })
    .from(episodicRecords)
    .where(
      and(
        eq(episodicRecords.campaignId, campaignId),
        gte(episodicRecords.turnNumber, from),
        lte(episodicRecords.turnNumber, to),
        notTombstoned(episodicRecords),
      ),
    )
    .orderBy(episodicRecords.turnNumber);
  if (rows.length === 0) return `No turns recorded in ${from}-${to}.`;
  return rows.map((r) => `[Turn ${r.turnNumber}] ${r.narration.slice(0, 600)}`).join("\n\n");
}
