import type { Db } from "@/lib/db";
import { campaigns, pencilMarks, turns } from "@/lib/db/schema";
import { loadDirectionState, saveDirectionState } from "@/lib/direction/director";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import type { SakkanNote } from "@/lib/renderer/amendments";
import { ArcOverride } from "@/lib/types/arc";
import type {
  DirectionState,
  SakkanActiveNote,
  SakkanReading,
  SakkanState,
} from "@/lib/types/direction";
import { type AxisName, COVERED_AXES } from "@/lib/types/grounding";
import { PremiseContract, effectivePremise } from "@/lib/types/premise";
import { and, desc, eq } from "drizzle-orm";
import { scoreAxes } from "./score";

/**
 * The Sakkan (blueprint §4.5, §16 — the sakuga kantoku): drift is MEASURED,
 * never vibed. On cadence it samples the last SAKKAN_SAMPLE_TURNS of KA prose
 * (players' text excluded; degraded turns excluded — §5.5), scores it BLIND
 * through the C1 shared scorer (sakkan/score.ts — the judge never sees the
 * active values), and runs the drift band:
 *
 *   |effective − observed| ≥ DRIFT_THRESHOLD at confidence ≥ DRIFT_CONFIDENCE
 *   on DRIFT_CONSECUTIVE consecutive samples → a corrective note (a RETAKE,
 *   §16) into the Amendments — strong, expiring on one in-band read
 *   (|Δ| ≤ IN_BAND_DELTA). MARK_CONSECUTIVE consecutive same-axis drift →
 *   pencil-mark writer #3 (Learned layer).
 *
 * The band compares against the EFFECTIVE premise (active ⊕ arc_override,
 * §4.2), not raw active: during an override the page is SUPPOSED to read at
 * the override's values — measuring against raw active would set the Sakkan
 * against the Director's own deviation. (§4.5 letter says "active"; §4.2's
 * effective-premise definition is the operative intent. Interpretation
 * surfaced in the C8 commit message.)
 *
 * Trust rule (§4.5): advisory input to pressure — never a hard
 * reject/regenerate loop. The Sakkan writes notes; it never blocks a turn.
 */

export const SAKKAN_INTERVAL_TURNS = 8;
export const SAKKAN_SAMPLE_TURNS = 6;
export const DRIFT_THRESHOLD = 2;
export const DRIFT_CONFIDENCE = 0.6;
export const DRIFT_CONSECUTIVE = 2;
export const IN_BAND_DELTA = 1;
export const MARK_CONSECUTIVE = 3;
export const SAKKAN_PROVENANCE = "sakkan";

/**
 * Cadence (§4.5): every SAKKAN_INTERVAL_TURNS since the last sample, OR a
 * sakuga scene just landed, OR the session is closing. Pure.
 */
export function sakkanDue(
  state: DirectionState,
  turnNumber: number,
  opts: { sakuga?: boolean; sessionClose?: boolean } = {},
): boolean {
  // Turn 0 is the pilot's Phase A — nothing has been narrated yet, so there is
  // no prose to sample. Never due, whatever the trigger.
  if (turnNumber <= 0) return false;
  if (opts.sakuga || opts.sessionClose) return true;
  const last = state.sakkan?.last_sample_turn ?? 0;
  return turnNumber - last >= SAKKAN_INTERVAL_TURNS;
}

/** campaigns.tier_models → TierSelection, falling back to the infra default (director's pattern). */
function resolveSelection(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

/** Membership guard that narrows a raw axis string to a grounded AxisName. */
function isCovered(axis: string): axis is AxisName {
  return (COVERED_AXES as readonly string[]).includes(axis);
}

/**
 * One full sample: gather prose (last SAKKAN_SAMPLE_TURNS complete,
 * non-degraded turns' narration, oldest→newest) → scored set = the Charter's
 * currently rendered axes (DirectionState.settei.rendered_axes ∩
 * COVERED_AXES; uncovered axes are SKIPPED with a warn, never thrown — the
 * gap rule guards the scorer, the Sakkan degrades gracefully) plus any axis
 * with an active note → scoreAxes (campaign's judgment tier) → drift-band
 * update per axis (counters, note fire/expire, writer #3 at exactly
 * MARK_CONSECUTIVE — once, not every sample after) → save DirectionState
 * (last_sample_turn, readings, active_notes).
 *
 * Fewer than 1 usable turn of prose, zero scoreable axes, or a turn already
 * sampled (last_sample_turn ≥ turnNumber — one window is one sample, whoever
 * asks) → no-op (returns null); the counters neither advance nor reset on a
 * skipped sample.
 */
export async function runSakkanSample(
  db: Db,
  campaignId: string,
  turnNumber: number,
  opts?: { trigger?: "interval" | "sakuga" | "session_close" },
): Promise<{ scored: number; notesActive: number } | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`runSakkanSample: campaign ${campaignId} not found`);

  const contract = PremiseContract.parse(campaign.premiseContract);
  const selection = resolveSelection(campaign.tierModels);
  const parsedOverride = ArcOverride.safeParse(campaign.arcOverride);
  // The band compares against the EFFECTIVE premise (active ⊕ arc_override, §4.2):
  // during an override the page is SUPPOSED to read at the override's values, so
  // measuring against raw active would set the Sakkan against the Director's own
  // deliberate deviation (see the file header — the §4.2 effective definition is
  // the operative intent behind §4.5's "active").
  const effective = effectivePremise(
    contract.active,
    parsedOverride.success ? parsedOverride.data : null,
  );

  const state = await loadDirectionState(db, campaignId);

  // Same-turn idempotency guard (C8 audit — the root of all three findings):
  // one prose window is ONE sample, whoever asks. Without this, a session
  // close re-scored the window G2 step 11c had just sampled (and a crashed
  // G2 replay re-scored a sakuga sample), double-advancing the counters and
  // promoting a single spike to "drift" — §4.5's two-consecutive-samples
  // contract is temporal evidence, and the same turn carries no new evidence.
  // This also makes G2's marker-AFTER ordering strictly right: a crash before
  // the state save retries legitimately; a crash after no-ops here.
  if ((state.sakkan?.last_sample_turn ?? 0) >= turnNumber) return null;

  // Scored set (§4.5): the Charter's currently rendered axes ∩ COVERED, plus any
  // axis carrying an active note (dedup). Uncovered axes are SKIPPED with a warn
  // — the gap rule guards the scorer (score.ts THROWS on them); the Sakkan
  // degrades gracefully rather than wedging the sample.
  const requested = [
    ...new Set([
      ...(state.settei?.rendered_axes ?? []),
      ...(state.sakkan?.active_notes ?? []).map((n) => n.axis),
    ]),
  ];
  const axes: AxisName[] = [];
  for (const a of requested) {
    if (isCovered(a)) axes.push(a);
    else console.warn(`[sakkan] skipping uncovered axis "${a}" (grounding-gap rule)`);
  }

  // Prose sample (§4.5): the last SAKKAN_SAMPLE_TURNS complete, non-degraded
  // turns' narration, oldest→newest. KA prose only — turns.narration is KA-only
  // (player input is a separate column); degraded turns are excluded (§5.5).
  const rows = await db
    .select({ turnNumber: turns.turnNumber, narration: turns.narration })
    .from(turns)
    .where(
      and(
        eq(turns.campaignId, campaignId),
        eq(turns.status, "complete"),
        eq(turns.degraded, false),
      ),
    )
    .orderBy(desc(turns.turnNumber))
    .limit(SAKKAN_SAMPLE_TURNS);
  const proses = rows
    .reverse()
    .map((r) => r.narration)
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  const sample = proses.join("\n\n--- scene break ---\n\n");

  // A skipped sample is NOT evidence: zero scoreable axes or zero usable prose →
  // no-op WITHOUT advancing counters or last_sample_turn (§4.5).
  if (axes.length === 0 || proses.length === 0) return null;

  // Trust rule (§4.5): the Sakkan advises, it never blocks. A scoring failure is
  // a skipped sample, never a thrown turn — counters stay untouched.
  let scores: Awaited<ReturnType<typeof scoreAxes>>;
  try {
    scores = await scoreAxes(selection, {
      sample,
      axes,
      name: opts?.trigger ? `sakkan_score:${opts.trigger}` : "sakkan_score",
      campaignId,
      turnNumber,
    });
  } catch (err) {
    console.warn(`[sakkan] scoring failed (turn ${turnNumber}) — sample skipped:`, err);
    return null;
  }

  const scoreByAxis = new Map<string, (typeof scores)[number]>();
  for (const s of scores) scoreByAxis.set(s.axis, s);

  const readings: Record<string, SakkanReading> = { ...(state.sakkan?.readings ?? {}) };
  const notesByAxis = new Map<string, SakkanActiveNote>();
  for (const n of state.sakkan?.active_notes ?? []) notesByAxis.set(n.axis, n);

  const marksToWrite: Array<{
    axis: AxisName;
    observed: number;
    wanted: number;
    evidence: string;
  }> = [];
  let scored = 0;

  for (const axis of axes) {
    const s = scoreByAxis.get(axis);
    // No score returned for an axis this sample → not evidence: leave its prior
    // reading and counter exactly as they were.
    if (!s) continue;
    scored++;

    const wanted = effective.treatment[axis];
    const observed = s.score;
    const delta = Math.abs(wanted - observed);
    const prior = readings[axis]?.consecutive_drift ?? 0;

    const drifting = delta >= DRIFT_THRESHOLD && s.confidence >= DRIFT_CONFIDENCE;
    const inBand = delta <= IN_BAND_DELTA;

    let consecutive = prior;
    if (drifting) {
      consecutive = prior + 1;
    } else if (inBand) {
      // One in-band read lifts the retake and clears the counter (§4.5).
      consecutive = 0;
      notesByAxis.delete(axis);
    }
    // The BETWEEN case — |Δ| ≥ 2 at low confidence, or 1 < |Δ| < 2 — is neither
    // evidence for nor against drift: the counter holds and any note stays.

    readings[axis] = {
      observed,
      confidence: s.confidence,
      at_turn: turnNumber,
      consecutive_drift: consecutive,
      evidence: s.evidence_span,
    };

    if (drifting && consecutive >= DRIFT_CONSECUTIVE) {
      // Upsert the retake. Refresh observed/active on every drifting sample while
      // active; since_turn keeps the ORIGINAL fire turn across refreshes.
      const existing = notesByAxis.get(axis);
      notesByAxis.set(axis, {
        axis,
        active: wanted,
        observed,
        since_turn: existing?.since_turn ?? turnNumber,
      });
    }

    // Writer #3 (§6.6): at EXACTLY MARK_CONSECUTIVE same-axis drift reports the
    // gap is calibration, not noise. The counter passes through this value once
    // (each drift read increments by 1), so the mark fires once, not every
    // sample after.
    if (drifting && consecutive === MARK_CONSECUTIVE) {
      marksToWrite.push({ axis, observed, wanted, evidence: s.evidence_span });
    }
  }

  // Marks first, then the state save (single writer at sample time, §4.5;
  // same-turn re-entry is guarded at the top of this function). Writing the
  // mark ahead of the counter save favours never losing a calibration over an
  // occasional double on an interrupted replay.
  if (marksToWrite.length > 0) {
    await db.insert(pencilMarks).values(
      marksToWrite.map((m) => {
        const dir = m.observed > m.wanted ? "down" : "up";
        return {
          campaignId,
          kind: "axis",
          topic: m.axis,
          direction: `${m.axis} has read ${fmt(m.observed)}/10 for ${MARK_CONSECUTIVE} straight samples while the premise wants ${fmt(m.wanted)}/10 — pull it ${dir} and hold it there.`,
          evidence: `"${m.evidence}"`,
          turnId: turnNumber,
          provenance: SAKKAN_PROVENANCE,
          confidence: 0.85,
        };
      }),
    );
  }

  const sakkan: SakkanState = {
    last_sample_turn: turnNumber,
    readings,
    active_notes: [...notesByAxis.values()],
  };
  await saveDirectionState(db, campaignId, { ...state, sakkan });

  return { scored, notesActive: sakkan.active_notes.length };
}

/**
 * The Amendments producer (C1's SakkanNote input finally has its writer):
 * active retakes as renderAmendments' typed notes. Pure read of state.
 */
export function activeSakkanNotes(state: DirectionState): SakkanNote[] {
  const notes: SakkanNote[] = [];
  for (const n of state.sakkan?.active_notes ?? []) {
    // active_notes store axis as a raw string; only surface grounded axes to the
    // typed Amendments producer (renderAmendments takes AxisName).
    if (isCovered(n.axis)) notes.push({ axis: n.axis, active: n.active, observed: n.observed });
  }
  return notes;
}

/** Integers render bare; fractional scores get one decimal. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The Director's dailies trend (§7.1 consumer #2): a compact plaintext block
 * for the cycle dossier — per-axis observed vs effective with drift arrows,
 * active retakes, and axes trending home. Empty string when no readings.
 */
export function gaugeTrend(state: DirectionState): string {
  const readings = Object.entries(state.sakkan?.readings ?? {});
  if (readings.length === 0) return "";

  const notesByAxis = new Map<string, SakkanActiveNote>();
  for (const n of state.sakkan?.active_notes ?? []) notesByAxis.set(n.axis, n);

  // Retakes first (the live corrections the Director acts on), then axes still
  // trending by drift depth, then alphabetical for a stable dossier.
  readings.sort(([a, ra], [b, rb]) => {
    const na = notesByAxis.has(a) ? 1 : 0;
    const nb = notesByAxis.has(b) ? 1 : 0;
    if (na !== nb) return nb - na;
    if (rb.consecutive_drift !== ra.consecutive_drift) {
      return rb.consecutive_drift - ra.consecutive_drift;
    }
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (const [axis, r] of readings.slice(0, 12)) {
    const note = notesByAxis.get(axis);
    if (note) {
      // The wanted value only lives on the note (SakkanReading is observed-only),
      // so the observed-vs-wanted delta renders for noted axes; others show the
      // blind read alone.
      const d = r.observed - note.active;
      const sign = d >= 0 ? "+" : "";
      lines.push(
        `${axis}: observed ${fmt(r.observed)} vs wanted ${fmt(note.active)} (Δ${sign}${d.toFixed(1)}, conf ${r.confidence.toFixed(2)}) — RETAKE ACTIVE since turn ${note.since_turn}`,
      );
    } else if (r.consecutive_drift > 0) {
      lines.push(
        `${axis}: observed ${fmt(r.observed)} (conf ${r.confidence.toFixed(2)}) — drifting ${r.consecutive_drift}/${DRIFT_CONSECUTIVE}, watching`,
      );
    } else {
      lines.push(
        `${axis}: observed ${fmt(r.observed)} (conf ${r.confidence.toFixed(2)}) — in band`,
      );
    }
  }
  return lines.join("\n");
}
