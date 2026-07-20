import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { arcs } from "@/lib/db/schema";
import {
  ArcBudget,
  COUR_EPISODES,
  type DirectorArcPlan,
  type PayoffContract,
} from "@/lib/types/direction";
import type { PremiseContract } from "@/lib/types/premise";
import { and, desc, eq, inArray } from "drizzle-orm";
import jsYaml from "js-yaml";
import { z } from "zod";

/**
 * The Arc Model machinery (blueprint §7.3): strata rows, budget arithmetic,
 * shape→expected-tension curves, genre priors. The Director plans top-down
 * (Arc granularity at M1); the Pacer executes bottom-up. Story-first
 * doctrine: arc length is dictated by the story, never by the sitting.
 *
 * Objectively measurable quantities (the user's requirement): position =
 * budget consumed; trajectory deviation = tracked tension vs the shape's
 * expected curve; phase overstay = turns_in_phase vs PHASE_GATES (pacer.ts);
 * payoff debt = unresolved contract items vs remaining budget.
 */

export type ArcRow = typeof arcs.$inferSelect;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Expected tension at `fraction` (0..1) of the arc's budget, per shape
 * (§7.3): rising climbs to a climax at ~80%; waves/cyclical peaks and
 * troughs; plateau flat with texture; falling declines; fragmented spikes
 * over a slow throughline. Pure function, unit-tested at the curve edges.
 */
export function expectedTension(shape: string, fraction: number): number {
  const f = clamp01(fraction);
  switch (shape) {
    // rising: linear 0.2→1.0 up to the 0.8 climax, then a falling tail to ~0.5.
    case "rising":
      return clamp01(f <= 0.8 ? 0.2 + (f / 0.8) * 0.8 : 1.0 - ((f - 0.8) / 0.2) * 0.5);
    // falling: linear decline 0.8→0.2 across the whole budget.
    case "falling":
      return clamp01(0.8 - 0.6 * f);
    // cyclical: two full sine waves oscillating between 0.3 and 0.8.
    case "cyclical":
      return clamp01(0.55 + 0.25 * Math.sin(4 * Math.PI * f));
    // plateau: flat 0.45 with a deterministic ±0.05 sine texture.
    case "plateau":
      return clamp01(0.45 + 0.05 * Math.sin(6 * Math.PI * f));
    // fragmented: spikes to 0.8 near every ~0.2 of budget over a slow rising
    // throughline (0.3→0.45) — episodic peaks over a threaded baseline.
    case "fragmented": {
      const throughline = 0.3 + 0.15 * f;
      const nearestSpike = Math.round(f / 0.2) * 0.2;
      const spiking = Math.abs(f - nearestSpike) <= 0.03;
      return clamp01(spiking ? 0.8 : throughline);
    }
    // unknown shape → neutral mid-band (defensive; ArcShape enum is validated upstream).
    default:
      return 0.5;
  }
}

// --- Genre budget priors (rule_library/arcs/templates.yaml) -------------------

const ArcTemplateEntry = z.object({
  value_key: z.enum(["fast", "moderate", "slow_burn"]),
  target: z.number().int().positive(),
  tolerance: z.number().int().nonnegative(),
  shape_note: z.string().min(1),
  rationale: z.string().min(1),
});
const ArcTemplateFile = z.object({
  library_slug: z.string(),
  category: z.string(),
  axis: z.string(),
  entries: z.array(ArcTemplateEntry).min(1),
});
type ArcTemplateEntry = z.infer<typeof ArcTemplateEntry>;
type PacingBand = ArcTemplateEntry["value_key"];

/** Hardcoded fallback priors — the yaml is the live source; this is the floor. */
const FALLBACK_PRIORS: Record<PacingBand, { target: number; tolerance: number }> = {
  fast: { target: 2, tolerance: 1 },
  moderate: { target: 4, tolerance: 2 },
  slow_burn: { target: 6, tolerance: 2 },
};

let _templates: Map<PacingBand, ArcTemplateEntry> | null | undefined;

/** Load + validate the arc-budget templates once; null on any load/parse failure. */
function loadArcTemplates(): Map<PacingBand, ArcTemplateEntry> | null {
  if (_templates !== undefined) return _templates;
  try {
    const path = join(process.cwd(), "rule_library", "arcs", "templates.yaml");
    const parsed = ArcTemplateFile.safeParse(jsYaml.load(readFileSync(path, "utf8")));
    if (!parsed.success) {
      _templates = null;
      return _templates;
    }
    _templates = new Map(parsed.data.entries.map((e) => [e.value_key, e]));
  } catch {
    _templates = null;
  }
  return _templates;
}

/** Treatment `pacing` (0–10) → band: ≥7 fast, 4–6 moderate, ≤3 slow burn. */
function pacingBand(pacing: number): PacingBand {
  if (pacing >= 7) return "fast";
  if (pacing >= 4) return "moderate";
  return "slow_burn";
}

/**
 * Genre-default budget priors (§7.3 sources of arc length): Treatment
 * `pacing` sets the band (fast IP: 2 episodes/arc; slow burn: 6), refined by
 * the rule library's arc templates (rule_library/arcs/templates.yaml). The
 * yaml is the live source when loadable; FALLBACK_PRIORS mirror it in code.
 */
export function budgetPriorFor(contract: PremiseContract): ArcBudget {
  const band = pacingBand(contract.active.treatment.pacing);
  const tmpl = loadArcTemplates()?.get(band);
  const prior = tmpl ?? FALLBACK_PRIORS[band];
  return { unit: "episodes", target: prior.target, tolerance: prior.tolerance };
}

/**
 * The Series stratum's budget by finitude (M2R R2): a finite story plans a
 * finale inside two cours ± one; an indefinite cycle widens tolerance to the
 * full width as an honest open horizon. The reader is the Director dossier's
 * series-horizon line ({@link seriesBudget}) — DESCRIPTIVE judgment context.
 * Never feed series rows into payoffDebt-style rushed math: at tolerance ==
 * target the (remaining <= tolerance) rule fires from episode zero (audit).
 * Season/series arithmetic is M3's; existing campaigns keep their old rows.
 */
export function seriesBudgetFor(finitude: PremiseContract["finitude"]): ArcBudget {
  return {
    unit: "episodes",
    target: COUR_EPISODES * 2,
    tolerance: finitude === "indefinite" ? COUR_EPISODES * 2 : COUR_EPISODES,
  };
}

/** The series row's stored budget — the dossier's series-horizon read. */
export async function seriesBudget(db: Db, campaignId: string): Promise<ArcBudget | null> {
  const [row] = await db
    .select({ budget: arcs.budget })
    .from(arcs)
    .where(and(eq(arcs.campaignId, campaignId), eq(arcs.stratum, "series"), notTombstoned(arcs)))
    .limit(1);
  const parsed = ArcBudget.safeParse(row?.budget);
  return parsed.success ? parsed.data : null;
}

// --- Strata rows --------------------------------------------------------------

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The single season-stratum scaffold row, if it exists (arc succession parents to it). */
async function seasonRowId(db: Db, campaignId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: arcs.id })
    .from(arcs)
    .where(and(eq(arcs.campaignId, campaignId), eq(arcs.stratum, "season"), notTombstoned(arcs)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Ensure the Series + Season scaffold rows exist (idempotent — called at
 * Director startup). Series descends its dramatic_question from the spark;
 * Season defaults to one cour (COUR_EPISODES) with the premise's shape.
 */
export async function ensureSeriesScaffold(
  db: Db,
  campaignId: string,
  contract: PremiseContract,
): Promise<{ seriesId: string; seasonId: string }> {
  const shape = contract.active.framing.arc_shape ?? "rising";
  const spark = contract.spark;

  const [existingSeries] = await db
    .select({ id: arcs.id })
    .from(arcs)
    .where(and(eq(arcs.campaignId, campaignId), eq(arcs.stratum, "series"), notTombstoned(arcs)))
    .limit(1);

  const seriesId =
    existingSeries?.id ??
    (
      await db
        .insert(arcs)
        .values({
          campaignId,
          name: "Series",
          stratum: "series",
          dramaticQuestion: spark,
          shape,
          budget: seriesBudgetFor(contract.finitude),
          phase: "setup",
          status: "active",
          turnId: 0,
          provenance: "director",
          confidence: 0.9,
        })
        .returning({ id: arcs.id })
    )[0]?.id;
  if (!seriesId) throw new Error("ensureSeriesScaffold: series insert returned nothing");

  const [existingSeason] = await db
    .select({ id: arcs.id })
    .from(arcs)
    .where(and(eq(arcs.campaignId, campaignId), eq(arcs.stratum, "season"), notTombstoned(arcs)))
    .limit(1);

  const seasonId =
    existingSeason?.id ??
    (
      await db
        .insert(arcs)
        .values({
          campaignId,
          name: "Season 1",
          stratum: "season",
          dramaticQuestion: `${spark} — this season's movement`,
          shape,
          // One-cour default; a two-cour season would plan a mid-season climax.
          budget: { unit: "episodes", target: COUR_EPISODES, tolerance: 4 },
          phase: "setup",
          status: "active",
          parentId: seriesId,
          turnId: 0,
          provenance: "director",
          confidence: 0.9,
        })
        .returning({ id: arcs.id })
    )[0]?.id;
  if (!seasonId) throw new Error("ensureSeriesScaffold: season insert returned nothing");

  return { seriesId, seasonId };
}

/** The single active arc-stratum row (status active|closing), or null. */
export async function getActiveArc(db: Db, campaignId: string): Promise<ArcRow | null> {
  const [row] = await db
    .select()
    .from(arcs)
    .where(
      and(
        eq(arcs.campaignId, campaignId),
        eq(arcs.stratum, "arc"),
        inArray(arcs.status, ["active", "closing"]),
        notTombstoned(arcs),
      ),
    )
    .orderBy(desc(arcs.turnId))
    .limit(1);
  return row ?? null;
}

/**
 * Apply the Director's arc plan (upsert semantics): update the active arc
 * row in place (name match) or close it and mint the successor under the
 * season. Returns whether the phase changed (the caller resets
 * DirectionState.phase_state on true). Provenance "director".
 */
export async function applyArcPlan(
  db: Db,
  campaignId: string,
  turnNumber: number,
  plan: DirectorArcPlan,
): Promise<{ arcId: string; phaseChanged: boolean }> {
  const active = await getActiveArc(db, campaignId);
  // Phase changes relative to the outgoing active arc; minting the first arc
  // is always a phase change (§7.1 resets phase_state on true).
  const phaseChanged = active ? plan.phase !== active.phase : true;

  // Explicit close, no successor.
  if (plan.status === "closed" && active) {
    await db.update(arcs).set({ status: "closed" }).where(eq(arcs.id, active.id));
    return { arcId: active.id, phaseChanged: false };
  }

  // Same name → update in place.
  if (active && sameName(active.name, plan.name)) {
    await db
      .update(arcs)
      .set({
        shape: plan.shape,
        budget: plan.budget,
        phase: plan.phase,
        payoffContract: plan.payoff_contract,
        status: plan.status,
        dramaticQuestion: plan.dramatic_question,
      })
      .where(eq(arcs.id, active.id));
    return { arcId: active.id, phaseChanged };
  }

  // Different name → close the old (if any), mint the successor under the season.
  if (active) {
    await db.update(arcs).set({ status: "closed" }).where(eq(arcs.id, active.id));
  }
  const parentId = await seasonRowId(db, campaignId);
  const [row] = await db
    .insert(arcs)
    .values({
      campaignId,
      name: plan.name,
      stratum: "arc",
      dramaticQuestion: plan.dramatic_question,
      shape: plan.shape,
      budget: plan.budget,
      phase: plan.phase,
      payoffContract: plan.payoff_contract,
      status: plan.status,
      parentId,
      turnId: turnNumber,
      provenance: "director",
      confidence: 0.9,
    })
    .returning({ id: arcs.id });
  if (!row) throw new Error("applyArcPlan: arc insert returned nothing");
  return { arcId: row.id, phaseChanged };
}

/**
 * Delimit a story movement: mint a CLOSED episode row under the active arc
 * (the Episode stratum's writer; its readers are arcPosition for
 * episode-denominated budgets and the recap's arc history).
 */
export async function closeEpisode(
  db: Db,
  campaignId: string,
  turnNumber: number,
  episode: { name: string; dramatic_question: string },
  parentArcId: string,
): Promise<void> {
  await db.insert(arcs).values({
    campaignId,
    name: episode.name,
    stratum: "episode",
    dramaticQuestion: episode.dramatic_question,
    // Episode shape/budget are non-read placeholders — arcPosition counts
    // closed episode ROWS, never their curves; the parent Arc carries the shape.
    shape: "rising",
    budget: { unit: "scenes", target: 1, tolerance: 0 },
    phase: "resolution",
    status: "closed",
    parentId: parentArcId,
    turnId: turnNumber,
    provenance: "director",
    confidence: 0.9,
  });
}

/**
 * Position = budget consumed (§7.3). scenes-denominated: turns since the
 * arc row's creation turn (turnId envelope column); episodes-denominated:
 * closed episode rows under the arc.
 */
export async function arcPosition(
  db: Db,
  campaignId: string,
  arc: ArcRow,
  currentTurn: number,
): Promise<{ consumed: number; target: number; fraction: number }> {
  const budget = arc.budget as ArcBudget;
  const target = budget.target > 0 ? budget.target : 1;

  let consumed: number;
  if (budget.unit === "episodes") {
    const episodes = await db
      .select({ id: arcs.id })
      .from(arcs)
      .where(
        and(
          eq(arcs.campaignId, campaignId),
          eq(arcs.stratum, "episode"),
          eq(arcs.parentId, arc.id),
          eq(arcs.status, "closed"),
          notTombstoned(arcs),
        ),
      );
    consumed = episodes.length;
  } else {
    consumed = Math.max(0, currentTurn - arc.turnId);
  }

  return { consumed, target, fraction: clamp01(consumed / target) };
}

/** Payoff debt: open contract items vs remaining budget (§7.3 rush signal). */
export function payoffDebt(
  arc: ArcRow,
  position: { consumed: number; target: number },
): { openItems: number; remaining: number; rushed: boolean } {
  const contract = (Array.isArray(arc.payoffContract) ? arc.payoffContract : []) as PayoffContract;
  const openItems = contract.filter((item) => item.status === "open").length;
  const remaining = position.target - position.consumed;
  const tolerance = (arc.budget as ArcBudget).tolerance;
  const rushed = openItems > 0 && remaining <= tolerance;
  return { openItems, remaining, rushed };
}
