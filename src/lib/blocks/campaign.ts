import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, pencilMarks, pins } from "@/lib/db/schema";
import { renderSettei } from "@/lib/renderer/settei";
import { KA_CONTRACT } from "@/lib/turn/ka";
import { PencilMark, activeMarks } from "@/lib/types/marks";
import { PremiseContract } from "@/lib/types/premise";
import { and, asc, eq } from "drizzle-orm";
import { type AssembledBlocks, assembleBlocks } from "./assemble";
import { compactionWatermark, loadBeats, workingWindow } from "./compaction";

/**
 * DB-backed block assembly for a campaign. Block 1 = the rendered Settei
 * (C1's renderer over the live contract + standing marks) + presentation
 * vocabulary grants (§8) + the KA's standing execution contract — all
 * session-stable, cached until a premise edit or session-boundary rebuild
 * (§4.4a).
 */
export async function assembleForCampaign(
  db: Db,
  campaignId: string,
): Promise<AssembledBlocks | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const parsed = PremiseContract.safeParse(campaign.premiseContract);
  if (!parsed.success) return null;
  const contract = parsed.data;

  const [beats, exchanges, pinRows, watermark, markRows] = await Promise.all([
    loadBeats(db, campaignId),
    workingWindow(db, campaignId),
    db
      .select()
      .from(pins)
      .where(and(eq(pins.campaignId, campaignId), notTombstoned(pins)))
      // Deterministic head: ties on position break on id, never row order.
      .orderBy(asc(pins.position), asc(pins.id)),
    compactionWatermark(db, campaignId),
    db
      .select()
      .from(pencilMarks)
      .where(and(eq(pencilMarks.campaignId, campaignId), notTombstoned(pencilMarks)))
      .orderBy(asc(pencilMarks.turnId), asc(pencilMarks.id)),
  ]);

  const marks = activeMarks(
    markRows
      .map((r) =>
        PencilMark.safeParse({
          kind: r.kind,
          topic: r.topic,
          direction: r.direction,
          evidence: r.evidence ?? "",
          turn_id: r.turnId,
          confidence: r.confidence,
          ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
        }),
      )
      .filter((p) => p.success)
      .map((p) => p.data),
  );

  const settei = renderSettei({ contract, marks });
  if (settei.uncoveredExtremes.length > 0) {
    console.warn("[blocks] premise extremes without grounding — author exemplars", {
      campaignId,
      axes: settei.uncoveredExtremes,
    });
  }

  const grants = contract.presentation_vocabulary.grants;
  const presentation =
    grants.length > 0
      ? `\n\n## Presentation vocabulary (granted — use at your judgment, never as obligation)\n${grants.map((g) => `- ${g}`).join("\n")}`
      : "";

  const block1 = `${settei.text}${presentation}\n\n${KA_CONTRACT}`;

  return assembleBlocks({
    settei: block1,
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
