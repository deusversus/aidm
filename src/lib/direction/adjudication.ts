import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, episodicRecords } from "@/lib/db/schema";
import { STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import {
  type AdjudicatedVerdict,
  SEED_ADJUDICATION_CAPS,
  SEED_ADJUDICATION_MIN_CONFIDENCE,
  SEED_VERDICTS,
  SeedAdjudication,
  type SeedVerdict,
  normalizeSeedVerdict,
} from "@/lib/types/direction";
import { and, desc, eq } from "drizzle-orm";
import {
  type SeedUnderReview,
  adjustSeedWindow,
  autoResolveSeed,
  conflictAbandonSeed,
  markCandidatesAdjudicated,
  recordSeedMention,
  seedsUnderReview,
  windowOf,
} from "./seeds";

/**
 * The batched seed adjudication (blueprint §7.6) — ONE judged call per
 * Director cycle that does all three jobs the ledger could not do alone:
 *
 *   1. promotes accumulated ORGANIC candidates to mentions (or lets them go),
 *   2. judges PAYOFF against each callback-ready seed's `expected_payoff` —
 *      the field the 2026-08-01 audit found had never been read by anything
 *      but string luck,
 *   3. flags CONFLICT auto-abandonment for seeds the story has contradicted.
 *
 * The cost law is structural, not aspirational: `seedsUnderReview` renders
 * only candidate / callback-ready / conflict-suspect seeds under per-bucket
 * caps, so a hundred-seed ledger costs exactly what a ten-seed ledger costs.
 * When nothing is under review the call is skipped entirely.
 *
 * MENTION COUNTERS MAY LAG ONE DIRECTOR INTERVAL. A candidate found on turn 12
 * becomes a mention when the next cycle fires (≤ 8 turns later, §7.1 cadence).
 * The blueprint states this and accepts it — the alternative is a judged call
 * per turn, which is the cost shape §7.6 exists to refuse.
 */

const ADJUDICATOR_SYSTEM = [
  "You are the seed adjudicator for a long-form story engine. A SEED is a planted",
  "narrative promise — a debt, an omen, a question the story owes an answer to. You",
  "are given recent scenes and a short list of seeds under review, and you decide,",
  "per seed, what the story actually did with it. Verdicts:",
  "MENTION — the scene genuinely surfaced this seed on the page (not merely shared",
  "a setting, a name, or a mood with it); PAYOFF — the seed's expected payoff has",
  "LANDED, in the fiction, on the page, in a way a reader would recognize as the",
  "promise being kept; CONFLICT — the story has contradicted this seed, so it can",
  "no longer be paid and should be let go; EXTEND — the seed is alive and wanted but",
  "the story has not reached it yet, so its payoff window should be pushed out to a",
  "later turn; NONE — nothing happened to this seed.",
  "Be strict about PAYOFF and CONFLICT: those END a thread. Thematic resonance is",
  "not a payoff, and an unmentioned seed is not a contradicted one. Judge only from",
  "the scenes given; give one short piece of evidence per verdict, and a confidence",
  "from 0 to 1 that says how sure the page makes you.",
].join(" ");

/** Clip a fragment to keep the evidence window bounded. */
function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Apply the ceilings the schema can no longer carry (types/direction.ts: the
 * strict-output grammar strips `minimum`/`maximum`/`maxItems`, and the enum
 * VOCABULARY along with them). Out-of-range refs drop, duplicates keep the
 * first verdict, confidences pin to [0,1], the verdict word is normalized to
 * the lowercase vocabulary (unknown → `none`, warned, M3R4 R-1), and the batch itself
 * is capped at one verdict per rendered seed. The batch always survives — a
 * surplus, mis-cased or malformed verdict must never cost the other seeds
 * their adjudication.
 */
export function clampAdjudication(
  verdicts: SeedVerdict[],
  renderedCount: number,
): AdjudicatedVerdict[] {
  const seen = new Set<number>();
  const kept: AdjudicatedVerdict[] = [];
  let dropped = 0;
  const outOfVocab: string[] = [];
  for (const v of verdicts) {
    if (v.seed_ref < 0 || v.seed_ref >= renderedCount || seen.has(v.seed_ref)) {
      dropped++;
      continue;
    }
    seen.add(v.seed_ref);
    const verdict = normalizeSeedVerdict(v.verdict);
    // A CASE fix is bookkeeping; a word the vocabulary does not hold is a
    // silent no-op on a seed the judge meant to act on. It reads as "none"
    // either way, so without this line a model systematically answering
    // "resolve" looks exactly like a model that found nothing.
    if (!(SEED_VERDICTS as readonly string[]).includes(v.verdict.trim().toLowerCase())) {
      outOfVocab.push(`seed ${v.seed_ref}: "${v.verdict}"`);
    }
    kept.push({
      ...v,
      verdict,
      confidence: Math.min(1, Math.max(0, v.confidence)),
    });
    if (kept.length >= renderedCount) break;
  }
  if (dropped > 0) {
    console.warn(
      `[adjudication] dropped ${dropped} out-of-range/duplicate verdict(s) — batch kept`,
    );
  }
  if (outOfVocab.length > 0) {
    console.warn(
      `[adjudication] ${outOfVocab.length} out-of-vocabulary verdict(s) normalized to "none" — ${outOfVocab.join(", ")}`,
    );
  }
  return kept;
}

export interface AdjudicationResult {
  reviewed: number;
  mentions: number;
  payoffs: number;
  conflicts: number;
  windowAdjustments: number;
  /** Verdicts the judge hedged below SEED_ADJUDICATION_MIN_CONFIDENCE. */
  lowConfidence: number;
}

const EMPTY: AdjudicationResult = {
  reviewed: 0,
  mentions: 0,
  payoffs: 0,
  conflicts: 0,
  windowAdjustments: 0,
  lowConfidence: 0,
};

/** The shared evidence window: what the story has actually said lately. */
async function recentEvidence(db: Db, campaignId: string): Promise<string> {
  const rows = await db
    .select({
      turnNumber: episodicRecords.turnNumber,
      fragment: episodicRecords.narratedFragment,
      narration: episodicRecords.narration,
    })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(SEED_ADJUDICATION_CAPS.evidence_turns);
  if (rows.length === 0) return "(no scenes recorded yet)";
  return rows
    .reverse()
    .map((r) => `turn ${r.turnNumber}: ${clip(r.fragment ?? r.narration ?? "(no record)")}`)
    .join("\n");
}

/** One rendered under-review line, with the tags saying WHY it is here. */
function renderSeed(entry: SeedUnderReview, index: number): string {
  const w = windowOf(entry.seed);
  const tags: string[] = [];
  if (entry.pending.length > 0) {
    tags.push(
      `surfaced in scenes ${entry.pending.map((c) => c.t).join(",")} by similarity — judge whether it truly landed`,
    );
  }
  if (entry.callbackReady) tags.push("callback-ready — judge its payoff");
  if (entry.overdue) tags.push(`overdue since turn ${w.to} — judge whether the story broke it`);
  const payoff = entry.seed.expectedPayoff?.trim();
  return [
    `${index}. "${clip(entry.seed.description, 160)}"`,
    payoff ? `   expects: ${clip(payoff, 200)}` : "   expects: (no payoff recorded)",
    `   planted turn ${entry.seed.plantedTurn}, window ${w.from}-${w.to}, mentions ${entry.seed.mentionCount}`,
    `   under review because: ${tags.join(" · ")}`,
  ].join("\n");
}

/** campaigns.tier_models → TierSelection, falling back to the infra default. */
function resolveSelection(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

/**
 * Run the batched adjudication for one Director cycle. Called at the TOP of
 * the cycle so the Director's own dossier already reflects the verdicts —
 * mention counts current, payoffs resolved, contradicted seeds let go — rather
 * than planning against a ledger one interval stale.
 */
export async function adjudicateSeeds(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<AdjudicationResult> {
  const review = await seedsUnderReview(db, campaignId, turnNumber);
  if (review.length === 0) return EMPTY;

  const [campaign] = await db
    .select({ tierModels: campaigns.tierModels })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  const selection = resolveSelection(campaign?.tierModels);

  const evidence = await recentEvidence(db, campaignId);
  const prompt = [
    `# Seed adjudication — turn ${turnNumber}`,
    "",
    "## Recent scenes (the only evidence — judge from these, nothing else)",
    evidence,
    "",
    "## Seeds under review",
    review.map((entry, i) => renderSeed(entry, i)).join("\n"),
    "",
    "## Your task",
    `Emit ONE verdict per seed above, at most ${review.length} in total, each carrying that seed's seed_ref (its number), a verdict, one short evidence phrase, and a confidence from 0 to 1. Surplus, duplicate, and out-of-range verdicts are discarded unread. For EXTEND, give new_window_to as a turn number later than ${turnNumber}. A verdict below ${SEED_ADJUDICATION_MIN_CONFIDENCE} confidence is recorded and NOT acted on — say NONE rather than hedge.`,
  ].join("\n");

  const emitted = await callJudgment(selection, {
    name: "seed_adjudication",
    schema: SeedAdjudication,
    campaignId,
    turnNumber,
    // A Director-cadence call, not the player's turn — the ledger files it
    // with the cycle it belongs to (M3 C1 spend attribution).
    phase: "director_cycle",
    maxTokens: STRUCTURED_RICH,
    effort: "high",
    system: ADJUDICATOR_SYSTEM,
    prompt,
  });

  const verdicts = clampAdjudication(emitted.verdicts, review.length);
  const result: AdjudicationResult = { ...EMPTY, reviewed: review.length };

  for (const v of verdicts) {
    const entry = review[v.seed_ref];
    if (!entry) continue;
    if (v.verdict !== "none" && v.confidence < SEED_ADJUDICATION_MIN_CONFIDENCE) {
      result.lowConfidence++;
      continue;
    }
    switch (v.verdict) {
      case "mention":
        await recordSeedMention(db, entry.seed.id);
        result.mentions++;
        break;
      case "payoff":
        await autoResolveSeed(db, entry.seed.id, turnNumber);
        result.payoffs++;
        break;
      case "conflict":
        await conflictAbandonSeed(db, entry.seed.id);
        result.conflicts++;
        break;
      case "extend": {
        if (v.new_window_to === undefined) break;
        const next = await adjustSeedWindow(db, entry.seed, turnNumber, v.new_window_to);
        if (next) result.windowAdjustments++;
        break;
      }
      default:
        break;
    }
  }

  // Every REVIEWED seed's candidates are spent, verdict or not: an unanswered
  // candidate must not come back to be re-judged next cycle (the cost law), and
  // the organic sweep will produce a fresh one the moment the story touches it
  // again.
  for (const entry of review) {
    if (entry.pending.length > 0) await markCandidatesAdjudicated(db, entry.seed.id);
  }

  return result;
}
