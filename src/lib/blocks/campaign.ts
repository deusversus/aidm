import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, pencilMarks, pins, turns } from "@/lib/db/schema";
import { type Settei, renderSettei } from "@/lib/renderer/settei";
import { KA_CONTRACT } from "@/lib/turn/ka";
import { DirectionState, SetteiSnapshot } from "@/lib/types/direction";
import { PencilMark, activeMarks } from "@/lib/types/marks";
import { PremiseContract } from "@/lib/types/premise";
import { and, asc, desc, eq } from "drizzle-orm";
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

  // id + provenance are REQUIRED by the PencilMark contract — omitting them
  // failed every safeParse and silently dropped ALL standing marks from the
  // Settei since C1 (caught by the C7 session agent). Same defect existed in
  // layout's Amendments mapping; both fixed together.
  const marks = activeMarks(
    markRows
      .map((r) =>
        PencilMark.safeParse({
          id: r.id,
          kind: r.kind,
          topic: r.topic,
          direction: r.direction,
          evidence: r.evidence ?? "",
          turn_id: r.turnId,
          provenance: r.provenance,
          confidence: r.confidence,
          ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
        }),
      )
      .filter((p) => p.success)
      .map((p) => p.data),
  );

  // Block 1's Settei is FROZEN per session (§4.4a): when a snapshot exists,
  // render from it — never from live marks — so a mid-session G2 mark write
  // can't silently bust the Block-1 prefix cache (§5.6). Absent (pre-C7
  // campaign / first assembly) → render as before AND lazily freeze it once;
  // session open re-freezes it through direction/session.rebuildSettei.
  const dir = DirectionState.safeParse(campaign.directionState);
  const snapshot = dir.success ? dir.data.settei : undefined;
  let setteiText: string;
  let uncoveredExtremes: readonly string[];
  if (snapshot) {
    setteiText = snapshot.text;
    uncoveredExtremes = snapshot.uncovered_extremes;
  } else {
    const rendered = renderSettei({ contract, marks });
    setteiText = rendered.text;
    uncoveredExtremes = rendered.uncoveredExtremes;
    await freezeSettei(db, campaignId, dir.success ? dir.data : null, rendered);
  }
  if (uncoveredExtremes.length > 0) {
    console.warn("[blocks] premise extremes without grounding — author exemplars", {
      campaignId,
      axes: uncoveredExtremes,
    });
  }

  const grants = contract.presentation_vocabulary.grants;
  const presentation =
    grants.length > 0
      ? `\n\n## Presentation vocabulary (granted — use at your judgment, never as obligation)\n${grants.map((g) => `- ${g}`).join("\n")}`
      : "";

  const block1 = `${setteiText}${presentation}\n\n${KA_CONTRACT}`;

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

/**
 * Lazy Settei freeze for a campaign with no snapshot yet (first assembly /
 * pre-C7). Best-effort: the live render already returned, so a write failure
 * never fails the assembly. rebuilt_at_turn is the current max turn — marks
 * newer than it ride Amendments until the next session-open rebuild.
 */
async function freezeSettei(
  db: Db,
  campaignId: string,
  direction: DirectionState | null,
  rendered: Settei,
): Promise<void> {
  try {
    const [latest] = await db
      .select({ turnNumber: turns.turnNumber })
      .from(turns)
      .where(eq(turns.campaignId, campaignId))
      .orderBy(desc(turns.turnNumber))
      .limit(1);
    const next: DirectionState = {
      ...(direction ?? DirectionState.parse({})),
      settei: SetteiSnapshot.parse({
        text: rendered.text,
        charter_tokens: rendered.charterTokens,
        rendered_axes: rendered.renderedAxes,
        uncovered_extremes: rendered.uncoveredExtremes,
        rebuilt_at_turn: latest?.turnNumber ?? 0,
        rebuilt_at: new Date().toISOString(),
      }),
    };
    await db.update(campaigns).set({ directionState: next }).where(eq(campaigns.id, campaignId));
  } catch (err) {
    console.warn("[blocks] lazy Settei freeze failed — live render served", {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
