import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, pins } from "@/lib/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type AssembledBlocks, assembleBlocks } from "./assemble";
import { compactionWatermark, loadBeats, workingWindow } from "./compaction";

/**
 * DB-backed block assembly for a campaign. Until the M1 Renderer lands,
 * Block 1 is a minimal-but-real identity block (title + verbatim spark) —
 * enough for the cache plumbing to be exercised end-to-end without
 * inventing a premature Settei renderer.
 */
export async function assembleForCampaign(
  db: Db,
  campaignId: string,
): Promise<AssembledBlocks | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const contract = campaign.premiseContract as { spark?: string } | null;
  if (!contract?.spark) return null;

  const settei = [
    `# ${campaign.title}`,
    "",
    `The spark (player's words, verbatim): ${contract.spark}`,
    "",
    "(Minimal Block 1 — the rendered Settei lands with the M1 Renderer.)",
  ].join("\n");

  const [beats, exchanges, pinRows, watermark] = await Promise.all([
    loadBeats(db, campaignId),
    workingWindow(db, campaignId),
    db
      .select()
      .from(pins)
      .where(and(eq(pins.campaignId, campaignId), notTombstoned(pins)))
      // Deterministic head: ties on position break on id, never row order.
      .orderBy(asc(pins.position), asc(pins.id)),
    compactionWatermark(db, campaignId),
  ]);

  return assembleBlocks({
    settei,
    beats,
    exchanges,
    pins: pinRows.map((p) => ({
      position: p.position,
      content: p.content,
      sourceTurn: p.sourceTurn,
    })),
    watermark,
  });
}
