import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, episodicRecords } from "@/lib/db/schema";
import { STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import {
  type AdjudicatedMention,
  type AdjudicatedVerdict,
  MENTION_ANSWERS,
  SEED_ADJUDICATION_CAPS,
  SEED_ADJUDICATION_MIN_CONFIDENCE,
  SEED_DESCRIPTION_RENDER_CHARS,
  SEED_VERDICTS,
  SeedAdjudication,
  type SeedMentionFinding,
  type SeedVerdict,
  mentionSurfaced,
  normalizeSeedVerdict,
} from "@/lib/types/direction";
import { and, desc, eq, inArray } from "drizzle-orm";
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
  "are given the story's ACTUAL SCENES and a short list of seeds under review, and",
  "you answer TWO SEPARATE QUESTIONS about them.",
  "",
  "QUESTION ONE — DID IT SURFACE? For each seed the list marks with candidate",
  "scenes, say whether that thread genuinely came up ON THE PAGE in one of them:",
  "named, unmistakably alluded to, acted on, or asked after — as opposed to merely",
  "sharing a setting, a name, or a mood with it. Those candidates are a machine's",
  "similarity guess and nothing more; you are the only reader the engine has.",
  'Answer surfaced="yes" with the turn whose scene shows it and the phrase on the',
  'page that does, or surfaced="no" when the resemblance is only atmospheric. A',
  '"yes" IS ITS CITATION: without the quoted phrase and the turn it came from, it',
  'is a "no", and the engine will read it as one. Quote the scene, not the seed.',
  "This question is about ATTENTION, not payoff: a seed may surface a dozen times before",
  "it is ever paid, and saying yes ENDS NOTHING — it records that the story is",
  "keeping the promise alive.",
  "",
  "QUESTION TWO — HOW DOES IT SETTLE? Then, per seed:",
  "PAYOFF — the seed's expected payoff has LANDED, in the fiction, on the page, in",
  "a way a reader would recognize as the promise being kept; CONFLICT — the story",
  "has contradicted this seed, so it can no longer be paid and should be let go;",
  "EXTEND — the seed is alive and wanted but the story has not reached it yet, so",
  "its payoff window should be pushed out to a later turn; NONE — it is alive and",
  "its window still holds it.",
  "Be strict about PAYOFF and CONFLICT: those END a thread. Thematic resonance is",
  "not a payoff, and an unmentioned seed is not a contradicted one. EXTEND is not",
  "strict: a seed marked CLOSING or OVERDUE that the story still wants is exactly",
  "what the push-out exists for — a promise kept late is worth more than one",
  "quietly broken.",
  "",
  "Judge only from the scenes given. Give one short piece of evidence per answer,",
  "and a confidence from 0 to 1 that says how sure the page makes you — your real",
  "confidence, not a rounded-up one: a low number is recorded and simply not acted",
  "on.",
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

/**
 * The mention findings' clamp — the same law as {@link clampAdjudication}, over
 * the question that now has its own slot (M3R4 R-2). Out-of-range and duplicate
 * seed_refs drop, the first finding per seed wins, confidences pin to [0,1], and
 * the yes/no word normalizes engine-side (unknown → NO, warned): the batch
 * always survives.
 *
 * AND THE CITATION IS PART OF THE ANSWER (R-2 audit). A "yes" carrying no
 * quoted phrase, or naming a turn this batch never showed the judge, is not a
 * reading of the page — it is the model agreeing with the cosine sweep that
 * proposed the seed. Both read as NO here, loudly: the prompt now says the same
 * thing in words, and this is the half that cannot be talked out of it.
 * `evidenceTurns` is the set of turns actually RENDERED into the batch's
 * evidence block — an empty set means no scene was shown, so nothing can be
 * cited.
 */
export function clampMentions(
  findings: SeedMentionFinding[],
  renderedCount: number,
  evidenceTurns: ReadonlySet<number>,
): AdjudicatedMention[] {
  const seen = new Set<number>();
  const kept: AdjudicatedMention[] = [];
  let dropped = 0;
  const outOfVocab: string[] = [];
  const uncited: string[] = [];
  for (const f of findings) {
    if (f.seed_ref < 0 || f.seed_ref >= renderedCount || seen.has(f.seed_ref)) {
      dropped++;
      continue;
    }
    seen.add(f.seed_ref);
    if (!(MENTION_ANSWERS as readonly string[]).includes(f.surfaced.trim().toLowerCase())) {
      outOfVocab.push(`seed ${f.seed_ref}: "${f.surfaced}"`);
    }
    let surfaced = mentionSurfaced(f.surfaced);
    if (surfaced && f.evidence.trim() === "") {
      uncited.push(`seed ${f.seed_ref}: no quoted phrase`);
      surfaced = false;
    } else if (surfaced && !evidenceTurns.has(f.turn)) {
      uncited.push(`seed ${f.seed_ref}: turn ${f.turn} is not in this batch's evidence`);
      surfaced = false;
    }
    kept.push({
      ...f,
      surfaced,
      confidence: Math.min(1, Math.max(0, f.confidence)),
    });
    if (kept.length >= renderedCount) break;
  }
  if (dropped > 0) {
    console.warn(
      `[adjudication] dropped ${dropped} out-of-range/duplicate mention finding(s) — batch kept`,
    );
  }
  if (outOfVocab.length > 0) {
    console.warn(
      `[adjudication] ${outOfVocab.length} out-of-vocabulary mention answer(s) read as "no" — ${outOfVocab.join(", ")}`,
    );
  }
  if (uncited.length > 0) {
    console.warn(
      `[adjudication] ${uncited.length} UNCITED "yes" read as "no" — ${uncited.join(", ")}`,
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
  /**
   * Answers the judge hedged below SEED_ADJUDICATION_MIN_CONFIDENCE, recorded
   * and not acted on. ONE counter over BOTH questions: a hedged mention
   * finding and a hedged settle verdict each increment it, so this number is
   * "how often the judge was unsure", never "how many verdicts were dropped".
   */
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

/**
 * The evidence window: the story's ACTUAL SCENES (M3R4 R-2).
 *
 * What this replaces, measured on the N=50 soak: 12 `narratedFragment`s clipped
 * to 240 chars — a 149-char average against 3,525-char narrations, roughly 4% of
 * each page — under an instruction to "say NONE rather than hedge". The judge
 * was then asked whether a seed had genuinely surfaced. NONE was the correct
 * answer to the question it was actually being asked; 197 organic candidates
 * across 19 seeds produced zero promotions.
 *
 * Two priorities, in order, both bounded:
 *   1. every turn a seed's pending candidates NAME (newest first, capped per
 *      seed) — the mention question is literally about those scenes;
 *   2. the recency tail, so callback-ready and conflict-suspect seeds carrying
 *      no candidates are still judged against what the story has said lately.
 * Scenes are filled from the total budget in that order; a scene the budget
 * cannot hold whole falls back to its short fragment, and one it cannot hold at
 * all is COUNTED AND STATED, never silently absent. Cost scales with candidates
 * (§7.6's law) and is capped by SEED_ADJUDICATION_CAPS.evidence_total_chars.
 */
async function buildEvidence(
  db: Db,
  campaignId: string,
  review: SeedUnderReview[],
): Promise<{ text: string; turns: Set<number> }> {
  const caps = SEED_ADJUDICATION_CAPS;
  const candidateTurns: number[] = [];
  for (const entry of review) {
    const turns = entry.pending
      .map((c) => c.t)
      .sort((a, b) => b - a)
      .slice(0, caps.evidence_turns_per_seed);
    for (const t of turns) if (!candidateTurns.includes(t)) candidateTurns.push(t);
  }
  candidateTurns.sort((a, b) => b - a);

  const tail = await db
    .select({
      turnNumber: episodicRecords.turnNumber,
      fragment: episodicRecords.narratedFragment,
      narration: episodicRecords.narration,
    })
    .from(episodicRecords)
    .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
    .orderBy(desc(episodicRecords.turnNumber))
    .limit(caps.evidence_turns);

  const byTurn = new Map(tail.map((r) => [r.turnNumber, r]));
  const missing = candidateTurns.filter((t) => !byTurn.has(t));
  if (missing.length > 0) {
    const extra = await db
      .select({
        turnNumber: episodicRecords.turnNumber,
        fragment: episodicRecords.narratedFragment,
        narration: episodicRecords.narration,
      })
      .from(episodicRecords)
      .where(
        and(
          eq(episodicRecords.campaignId, campaignId),
          inArray(episodicRecords.turnNumber, missing),
          notTombstoned(episodicRecords),
        ),
      );
    for (const row of extra) byTurn.set(row.turnNumber, row);
  }
  if (byTurn.size === 0) return { text: "(no scenes recorded yet)", turns: new Set() };

  // Candidate-named scenes first, then the recency tail — the budget spends
  // itself on the scenes the mention question is actually about.
  const order = [
    ...candidateTurns.filter((t) => byTurn.has(t)),
    ...tail.map((r) => r.turnNumber).filter((t) => !candidateTurns.includes(t)),
  ];
  const rendered = new Map<number, string>();
  let used = 0;
  let omitted = 0;
  // The budget counts what is actually RENDERED — header, fallback label, the
  // separator each block is joined with, and a standing reserve for the
  // omission line that may follow them. Those last two were ~130 chars per
  // batch the old accounting spent without counting; a cap that measures only
  // the body is a cap that lies.
  const header = (turn: number) => `### turn ${turn}\n`;
  const JOIN = "\n\n";
  const OMISSION_RESERVE = 130;
  const budget = caps.evidence_total_chars - OMISSION_RESERVE;
  for (const turn of order) {
    const row = byTurn.get(turn);
    if (!row) continue;
    const whole = clip(row.narration ?? row.fragment ?? "(no record)", caps.evidence_scene_chars);
    const wholeCost = header(turn).length + whole.length + JOIN.length;
    if (used + wholeCost <= budget) {
      rendered.set(turn, whole);
      used += wholeCost;
      continue;
    }
    const short = `${clip(row.fragment ?? row.narration ?? "(no record)")} [only this scene's summary fragment fit the evidence budget]`;
    const shortCost = header(turn).length + short.length + JOIN.length;
    if (used + shortCost <= budget) {
      rendered.set(turn, short);
      used += shortCost;
      continue;
    }
    omitted++;
  }

  const lines = [...rendered.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, text]) => `### turn ${turn}\n${text}`);
  if (omitted > 0) {
    lines.push(
      `(${omitted} earlier scene(s) omitted — this batch's evidence budget is spent. Judge only what is above.)`,
    );
  }
  // The rendered turn set is the CITATION vocabulary (M3R4 R-2 audit): a
  // mention finding pointing at a turn that is not in here was not read off
  // this batch's evidence, whatever it says.
  return { text: lines.join(JOIN), turns: new Set(rendered.keys()) };
}

/** One rendered under-review line, with the tags saying WHY it is here. */
function renderSeed(entry: SeedUnderReview, index: number, currentTurn: number): string {
  const w = windowOf(entry.seed);
  const tags: string[] = [];
  if (entry.pending.length > 0) {
    const turns = entry.pending
      .map((c) => c.t)
      .sort((a, b) => b - a)
      .slice(0, SEED_ADJUDICATION_CAPS.evidence_turns_per_seed)
      .sort((a, b) => a - b);
    tags.push(
      `candidate scenes ${turns.join(",")} (a similarity guess) — QUESTION ONE: read those scenes and say whether it truly surfaced`,
    );
  }
  if (entry.callbackReady) tags.push("callback-ready — judge its payoff");
  if (entry.closing && !entry.overdue) {
    tags.push(
      `CLOSING — its window shuts at turn ${w.to}, in ${w.to - currentTurn} turn(s), and this may be the last cycle that can act: pay it, extend it (give new_window_to), or let it go`,
    );
  }
  if (entry.overdue) tags.push(`overdue since turn ${w.to} — judge whether the story broke it`);
  const payoff = entry.seed.expectedPayoff?.trim();
  return [
    `${index}. "${clip(entry.seed.description, SEED_DESCRIPTION_RENDER_CHARS)}"`,
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

  const evidence = await buildEvidence(db, campaignId, review);
  const prompt = [
    `# Seed adjudication — turn ${turnNumber}`,
    "",
    "## The scenes (the only evidence — judge from these, nothing else)",
    evidence.text,
    "",
    "## Seeds under review",
    review.map((entry, i) => renderSeed(entry, i, turnNumber)).join("\n"),
    "",
    "## Your task",
    "Answer BOTH questions in ONE emit.",
    `mentions — QUESTION ONE. One entry for each seed above that lists candidate scenes: its seed_ref (the number), surfaced "yes" or "no", the turn whose scene shows it (0 when nothing surfaced), a confidence from 0 to 1, and the phrase from that scene as evidence — the page's words, not a restatement of the seed. A "yes" whose evidence is blank, or whose turn is not one of the turns printed above, is recorded as "no". Seeds with no candidate scenes need no entry here.`,
    `verdicts — QUESTION TWO. ONE per seed above, at most ${review.length} in total: its seed_ref, a verdict of "payoff" | "conflict" | "extend" | "none", one short evidence phrase, and a confidence from 0 to 1. For "extend", give new_window_to as a turn number later than ${turnNumber}.`,
    `Surplus, duplicate, and out-of-range entries in either array are discarded unread. An answer below ${SEED_ADJUDICATION_MIN_CONFIDENCE} confidence is recorded and NOT acted on.`,
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
  const mentionFindings = clampMentions(emitted.mentions, review.length, evidence.turns);
  const result: AdjudicationResult = { ...EMPTY, reviewed: review.length };

  // QUESTION ONE first (M3R4 R-2): the mention slot is its own answer now, and
  // it runs before the settle loop so a seed credited here cannot be credited
  // twice by a model that also answers the legacy "mention" verdict below.
  const mentioned = new Set<string>();
  const cited: string[] = [];
  for (const m of mentionFindings) {
    const entry = review[m.seed_ref];
    if (!entry || !m.surfaced) continue;
    if (m.confidence < SEED_ADJUDICATION_MIN_CONFIDENCE) {
      result.lowConfidence++;
      continue;
    }
    await recordSeedMention(db, entry.seed.id);
    mentioned.add(entry.seed.id);
    // The validated citation, said out loud (R-2 audit). `turn` is stored
    // nowhere — no new column — so without this line the engine checks a turn
    // it then throws away, and a diagnosis of "which scene did the judge think
    // surfaced this?" has no answer at all.
    cited.push(`"${clip(entry.seed.description, 48)}" @ turn ${m.turn}`);
    result.mentions++;
  }
  if (cited.length > 0) {
    console.warn(
      `[adjudication] turn ${turnNumber}: promoted ${cited.length} mention(s) — ${cited.join("; ")}`,
    );
  }

  for (const v of verdicts) {
    const entry = review[v.seed_ref];
    if (!entry) continue;
    if (v.verdict !== "none" && v.confidence < SEED_ADJUDICATION_MIN_CONFIDENCE) {
      result.lowConfidence++;
      continue;
    }
    switch (v.verdict) {
      case "mention":
        // The settle slot no longer ASKS for this word, but the vocabulary
        // still holds it: a model answering the old way lands its mention
        // rather than falling silently to `none` (types/direction.ts).
        if (mentioned.has(entry.seed.id)) break;
        await recordSeedMention(db, entry.seed.id);
        mentioned.add(entry.seed.id);
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
