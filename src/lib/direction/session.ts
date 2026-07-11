import { assembleForCampaign } from "@/lib/blocks/campaign";
import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  compactedBeats,
  entities,
  episodicRecords,
  pencilMarks,
  sessionRecords,
  turns,
} from "@/lib/db/schema";
import { getActiveArc } from "@/lib/direction/arcs";
import {
  directorReview,
  directorStartup,
  loadDirectionState,
  saveDirectionState,
} from "@/lib/direction/director";
import { callbackReadySeeds } from "@/lib/direction/seeds";
import { reviewCatalog } from "@/lib/entity/janitor";
import { callJudgment, prewarmPrefix, streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { type SetteiInput, renderSettei } from "@/lib/renderer/settei";
import { runSakkanSample } from "@/lib/sakkan/sakkan";
import {
  ROLLING_CHECKPOINT_TURNS,
  SESSION_IDLE_TIMEOUT_MS,
  SetteiSnapshot,
} from "@/lib/types/direction";
import { PencilMark, activeMarks } from "@/lib/types/marks";
import { PremiseContract } from "@/lib/types/premise";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

/**
 * Session lifecycle (blueprint §9.4, hosted reality). A "session" is a play
 * sitting, recorded in session_records.
 *
 * OPEN sequence: lazy-close a stale open session (idle >
 * SESSION_IDLE_TIMEOUT_MS since last activity → closeTrigger idle_timeout)
 * → Director startup (turn 0) or review → Settei rebuild (batched pending
 * marks — the §4.4a regeneration trigger) → cache pre-warm → recap.
 *
 * CLOSE artifacts (v3 session_memory_writer.py conventions): director memo
 * (judgment tier, ≤400 words, headers Arc Status / Ready Payoffs / NPC
 * Spotlight Debt / Carry Forward), voice journal (judgment tier, ≤300
 * words, second person), yokoku (NARRATION tier — player-facing §9.4
 * next-episode tease: vibe-promise, never events, premise-rendered,
 * skippable where the premise wouldn't).
 *
 * Recap (§9.3): narration tier, premise-rendered (style, length, even
 * EXISTENCE are authorial judgment — the model may decline to recap);
 * sources: compacted beats + arc state + top episodic narrated fragments;
 * v3 recap.md discipline (3–5 sentences, present tense, ends on current
 * tension). Skipped when the campaign has no turns (the pilot opens cold).
 */

export interface OpenSessionResult {
  sessionNumber: number;
  /** False when an open, fresh session already exists (idempotent open). */
  opened: boolean;
  recap?: string;
  /** True when this open ran Director STARTUP (campaign's first session). */
  pilot: boolean;
}

/**
 * CALLER CONTRACT: drain lagging G2 first (the open route does —
 * settleG2IfPending). rebuildSettei is a READER of pencil marks (§5.8's
 * catch-up-before-reader), and a lagging G2 writing marks after the bake
 * would orphan them from both the Charter and the Amendments window. The
 * drain lives at the route so this module never imports compositor/g2
 * (which imports rollingCheckpoint from here — a cycle).
 */
export async function openSession(db: Db, campaignId: string): Promise<OpenSessionResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`openSession: campaign ${campaignId} not found`);
  if (campaign.status !== "active") {
    throw new Error(`openSession: campaign is ${campaign.status}, not active`);
  }

  const [latestSession] = await db
    .select()
    .from(sessionRecords)
    .where(and(eq(sessionRecords.campaignId, campaignId), notTombstoned(sessionRecords)))
    .orderBy(desc(sessionRecords.sessionNumber))
    .limit(1);
  const priorMax = latestSession?.sessionNumber ?? 0;

  const latest = await latestTurn(db, campaignId);
  const currentMaxTurn = latest?.turnNumber ?? 0;
  const isPilot = latest === null;

  // (1) Idempotent open: an already-open session that is still FRESH is a
  // no-op — the play view mounts and calls this on every load. Idle is
  // floored at the session's OWN openedAt (C7 audit): the previous sitting's
  // last turn is exactly the thing a NEW sitting is >30 min after, and
  // measuring from it spuriously auto-closed every just-opened session
  // before its first turn, churning session numbers and close-artifact spend.
  if (latestSession && latestSession.closedAt === null) {
    const turnActivity = latest?.completedAt?.getTime() ?? 0;
    const activity = Math.max(latestSession.openedAt.getTime(), turnActivity);
    const idleMs = Date.now() - activity;
    if (idleMs < SESSION_IDLE_TIMEOUT_MS) {
      return { sessionNumber: latestSession.sessionNumber, opened: false, pilot: false };
    }
    // Stale: auto-close (idle_timeout) before opening the next sitting so the
    // never-closed session still accrues its Learned-layer artifacts (§9.4).
    await closeSession(db, campaignId, "idle_timeout");
  }

  const newSessionNumber = priorMax + 1;
  const tier = resolveTier(campaign.tierModels);

  // (2) CLAIM the session row FIRST (C7 audit): the open sequence spans
  // several model round-trips, so a read-compute-insert shape let two
  // simultaneous mounts both run Director startup (duplicate strata rows)
  // and collide on the unique (campaignId, sessionNumber) index as a 500.
  // The partial unique index makes the claim single-winner; the loser
  // returns the winner's session as a graceful idempotent no-op.
  const claimed = await db
    .insert(sessionRecords)
    .values({
      campaignId,
      sessionNumber: newSessionNumber,
      turnId: currentMaxTurn,
      provenance: "session_lifecycle",
      confidence: 1,
    })
    .onConflictDoNothing()
    .returning({ id: sessionRecords.id });
  if (claimed.length === 0) {
    return { sessionNumber: newSessionNumber, opened: false, pilot: false };
  }

  try {
    // (3) Director: startup on the cold pilot, review otherwise (the review
    // cycle reads the last session memo in its dossier — Learned reader #2).
    if (isPilot) {
      await directorStartup(db, campaignId);
    } else {
      await directorReview(db, campaignId, currentMaxTurn);
    }

    // (4) The §4.4a regeneration trigger: bake pending marks into a frozen Settei.
    await rebuildSettei(db, campaignId, currentMaxTurn);

    // (5) Assemble the fresh blocks ONCE — reused for pre-warm and the recap so
    // the player's first real call reads a warm prefix (§5.6).
    const blocks = await assembleForCampaign(db, campaignId);

    // Pre-warm must never fail the open — the sitting starts regardless.
    if (blocks) {
      try {
        await prewarmPrefix(tier, blocks.system, { campaignId });
      } catch (err) {
        console.warn("[session] prewarm failed on open (non-fatal)", {
          campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (6) Recap — skipped on the pilot (cold open, nothing to recap). A recap
    // failure never fails the open: the sitting starts without the "previously
    // on" (§9.3 — the recap's very existence is discretionary).
    let recap: string | undefined;
    if (!isPilot && blocks) {
      try {
        recap = await composeRecap(db, campaignId, tier, blocks.system);
      } catch (err) {
        console.warn("[session] recap failed on open (non-fatal)", {
          campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      sessionNumber: newSessionNumber,
      opened: true,
      pilot: isPilot,
      ...(recap ? { recap } : {}),
    };
  } catch (err) {
    // A failed open sequence must not leave a claimed-but-unopened session:
    // the next mount would see it fresh and no-op, and a failed pilot
    // STARTUP would never retry — turn 1 would render without its plan.
    await db
      .delete(sessionRecords)
      .where(eq(sessionRecords.id, claimed[0]?.id ?? ""))
      .catch(() => {});
    throw err;
  }
}

export async function closeSession(
  db: Db,
  campaignId: string,
  trigger: "explicit" | "idle_timeout" | "rolling_checkpoint",
): Promise<{ yokoku?: string }> {
  const open = await openSessionRow(db, campaignId);
  if (!open) return { yokoku: undefined };

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  const tier = resolveTier(campaign?.tierModels);
  const latest = await latestTurn(db, campaignId);
  const currentMaxTurn = latest?.turnNumber ?? 0;

  // Each artifact is composed independently: one failure never costs the
  // others (v3 fire-and-forget, made durable). The row still closes.
  let directorMemo: string | undefined;
  let voiceJournal: string | undefined;
  let yokoku: string | undefined;
  try {
    directorMemo = await composeMemo(db, campaignId, tier, currentMaxTurn);
  } catch (err) {
    logComposerFailure("memo", campaignId, err);
  }
  try {
    voiceJournal = await composeVoiceJournal(db, campaignId, tier);
  } catch (err) {
    logComposerFailure("voice_journal", campaignId, err);
  }
  try {
    yokoku = await composeYokoku(db, campaignId, tier, currentMaxTurn);
  } catch (err) {
    logComposerFailure("yokoku", campaignId, err);
  }
  // §4.5 cadence: the Sakkan samples at every session close. Failure-isolated
  // like the composers (and the module's trust rule already never throws on
  // scoring failure); a skipped sample is a skipped measurement.
  if (currentMaxTurn > 0) {
    try {
      await runSakkanSample(db, campaignId, currentMaxTurn, { trigger: "session_close" });
    } catch (err) {
      logComposerFailure("sakkan", campaignId, err);
    }
  }
  // §6.5 janitor (M2 C1): review the live catalog for same-type semantic
  // near-dupes the deterministic tier can't see. Failure-isolated like the
  // composers and the Sakkan sample — a hygiene failure never blocks the close.
  if (currentMaxTurn > 0) {
    try {
      await reviewCatalog(db, campaignId, currentMaxTurn, tier);
    } catch (err) {
      logComposerFailure("janitor", campaignId, err);
    }
  }

  await db
    .update(sessionRecords)
    .set({
      closedAt: new Date(),
      closeTrigger: trigger,
      ...(directorMemo !== undefined ? { directorMemo } : {}),
      ...(voiceJournal !== undefined ? { voiceJournal } : {}),
      ...(yokoku !== undefined ? { yokoku } : {}),
    })
    .where(eq(sessionRecords.id, open.id));

  return { yokoku };
}

/**
 * §9.4 close trigger (3): every ROLLING_CHECKPOINT_TURNS turns, refresh the
 * OPEN session's memo in place (closedAt stays null) so a never-closed
 * session still accrues Learned-layer content. Called from G2 (engine
 * wiring); no-op off-cadence or with no open session.
 */
export async function rollingCheckpoint(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<void> {
  if (turnNumber <= 0 || turnNumber % ROLLING_CHECKPOINT_TURNS !== 0) return;
  const open = await openSessionRow(db, campaignId);
  if (!open) return;

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  const tier = resolveTier(campaign?.tierModels);
  let directorMemo: string | undefined;
  try {
    directorMemo = await composeMemo(db, campaignId, tier, turnNumber);
  } catch (err) {
    logComposerFailure("memo", campaignId, err);
  }
  if (directorMemo !== undefined) {
    await db.update(sessionRecords).set({ directorMemo }).where(eq(sessionRecords.id, open.id));
  }
}

/**
 * The §4.4a regeneration trigger: re-render the Settei from the contract +
 * ALL active pencil marks + DirectionState.arc_relevance, and freeze it
 * into DirectionState.settei with rebuilt_at_turn as the Amendments
 * watermark. Block 1 reads the snapshot (blocks/campaign.ts); marks newer
 * than the watermark ride Amendments until the next rebuild bakes them.
 */
export async function rebuildSettei(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<void> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return;
  const parsed = PremiseContract.safeParse(campaign.premiseContract);
  if (!parsed.success) return;

  const marks = await loadActiveMarks(db, campaignId);
  const direction = await loadDirectionState(db, campaignId);
  const settei = renderSettei({
    contract: parsed.data,
    marks,
    arcRelevance: direction.arc_relevance as SetteiInput["arcRelevance"],
  });

  direction.settei = SetteiSnapshot.parse({
    text: settei.text,
    charter_tokens: settei.charterTokens,
    rendered_axes: settei.renderedAxes,
    uncovered_extremes: settei.uncoveredExtremes,
    rebuilt_at_turn: currentTurn,
    rebuilt_at: new Date().toISOString(),
  });
  await saveDirectionState(db, campaignId, direction);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveTier(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

async function latestTurn(
  db: Db,
  campaignId: string,
): Promise<{ turnNumber: number; completedAt: Date | null } | null> {
  const [row] = await db
    .select({ turnNumber: turns.turnNumber, completedAt: turns.completedAt })
    .from(turns)
    .where(eq(turns.campaignId, campaignId))
    .orderBy(desc(turns.turnNumber))
    .limit(1);
  return row ?? null;
}

async function openSessionRow(db: Db, campaignId: string) {
  const [row] = await db
    .select()
    .from(sessionRecords)
    .where(
      and(
        eq(sessionRecords.campaignId, campaignId),
        notTombstoned(sessionRecords),
        isNull(sessionRecords.closedAt),
      ),
    )
    .orderBy(desc(sessionRecords.sessionNumber))
    .limit(1);
  return row ?? null;
}

/**
 * ALL active marks (not tombstoned, not superseded), selected like
 * blocks/campaign.ts. NOTE: the DB→PencilMark map here carries `id` and
 * `provenance` (both REQUIRED by the schema) — blocks/campaign.ts omits them,
 * so its own live render currently drops every mark; the frozen snapshot is
 * the path that actually carries standing calibration into Block 1 (§4.4a).
 */
async function loadActiveMarks(db: Db, campaignId: string): Promise<PencilMark[]> {
  const rows = await db
    .select()
    .from(pencilMarks)
    .where(and(eq(pencilMarks.campaignId, campaignId), notTombstoned(pencilMarks)))
    .orderBy(asc(pencilMarks.turnId), asc(pencilMarks.id));
  return activeMarks(
    rows
      .map((r) =>
        PencilMark.safeParse({
          id: r.id,
          kind: r.kind,
          topic: r.topic,
          direction: r.direction,
          evidence: r.evidence,
          turn_id: r.turnId,
          provenance: r.provenance,
          confidence: r.confidence,
          ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
        }),
      )
      .filter((p) => p.success)
      .map((p) => p.data),
  );
}

const SKIP_RE = /^skip[.!]?$/i;

/** Collect a player-facing narration reply; SKIP / refusal / empty → undefined. */
async function collectNarration(
  name: string,
  selection: TierSelection,
  system: TextBlockParam[],
  prompt: string,
  campaignId: string,
): Promise<string | undefined> {
  const { done } = streamNarration({
    name,
    selection,
    system,
    messages: [{ role: "user", content: prompt }],
    // NO tools: recap/yokoku are player-facing prose, never a commit_scene.
    tools: [],
    maxTokens: 4000,
    campaignId,
  });
  const result = await done();
  const text = result.prose.trim();
  if (result.refused || text.length === 0 || SKIP_RE.test(text)) return undefined;
  return text;
}

/** §9.3 recap — narration tier, premise-rendered, skippable. */
async function composeRecap(
  db: Db,
  campaignId: string,
  tier: TierSelection,
  system: TextBlockParam[],
): Promise<string | undefined> {
  const [beats, fragments, arc, direction] = await Promise.all([
    db
      .select({ content: compactedBeats.content, position: compactedBeats.position })
      .from(compactedBeats)
      .where(and(eq(compactedBeats.campaignId, campaignId), notTombstoned(compactedBeats)))
      .orderBy(desc(compactedBeats.position))
      .limit(6),
    db
      .select({
        turnNumber: episodicRecords.turnNumber,
        fragment: episodicRecords.narratedFragment,
      })
      .from(episodicRecords)
      .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
      .orderBy(desc(episodicRecords.turnNumber))
      .limit(5),
    getActiveArc(db, campaignId),
    loadDirectionState(db, campaignId),
  ]);

  const orderedBeats = [...beats].reverse();
  const orderedFragments = [...fragments].reverse().filter((f) => f.fragment?.trim());
  if (orderedBeats.length === 0 && orderedFragments.length === 0) return undefined;

  const parts: string[] = [
    'You are composing the "previously on" recap that opens this play session — player-facing prose in the story\'s own established voice, NOT a report.',
    "",
    "Style, length, and even whether to recap at all are yours to judge under this premise's presentation vocabulary: some stories open loud with a dramatic recap, some barely bother, and some quiet registers would never recap at all. If this premise is one that would NOT recap, reply with exactly SKIP and nothing else.",
    "",
    "If you do recap: 3–5 sentences, present tense, like the narration at the start of an anime episode. Hit the EMOTIONAL beats — what mattered, not a plot ledger. Reference specific names, places, and events from the context below. End on the current tension so it sets up THIS session. Never invent events that are not in the context.",
    "",
    "Context priority (most → least authoritative): recent narrated fragments, then story beats, then arc state, then current tension.",
    "",
  ];
  if (orderedFragments.length > 0) {
    parts.push("## Recent narrated fragments (oldest first)");
    for (const f of orderedFragments) parts.push(`- ${f.fragment}`);
    parts.push("");
  }
  if (orderedBeats.length > 0) {
    parts.push("## Story so far (beats, oldest first)");
    for (const b of orderedBeats) parts.push(`- ${b.content}`);
    parts.push("");
  }
  if (arc) {
    parts.push("## Active arc");
    parts.push(`${arc.name} — phase ${arc.phase}. Dramatic question: ${arc.dramaticQuestion}`);
    parts.push("");
  }
  parts.push("## Current tension");
  parts.push(`${direction.tension_level.toFixed(2)} on a 0 (calm) … 1 (breaking point) scale.`);

  return collectNarration("recap", tier, system, parts.join("\n"), campaignId);
}

/** §9.4 yokoku — narration tier, in-voice tease; vibe-promise, never events. */
async function composeYokoku(
  db: Db,
  campaignId: string,
  tier: TierSelection,
  currentTurn: number,
): Promise<string | undefined> {
  const blocks = await assembleForCampaign(db, campaignId);
  if (!blocks) return undefined;

  const [arc, readySeeds] = await Promise.all([
    getActiveArc(db, campaignId),
    callbackReadySeeds(db, campaignId, currentTurn),
  ]);

  const parts: string[] = [
    "You are composing the yokoku — the next-episode preview that plays as this session closes. Player-facing prose in the story's own established voice: a short, in-voice tease of what is coming (2–4 sentences).",
    "",
    "THE ONE RULE: promise a VIBE, never events. Anime yokoku famously overpromise and mislead — that genre-licensed vagueness is the point, because it must leave the player's next choices completely free. Tease mood, question, and momentum; never a plot beat, never an outcome, never who does what.",
    "",
    "Premise-rendered like everything else: if this premise is one whose previews barely relate to the episode (or that would not tease at all), lean into that — and if it would not do a yokoku at all, reply with exactly SKIP and nothing else.",
    "",
  ];
  if (arc) {
    parts.push(
      "## Where the story is pointed (the Director's plan — for your instinct only, never to state)",
    );
    parts.push(`${arc.name} — phase ${arc.phase}. Dramatic question: ${arc.dramaticQuestion}`);
    parts.push("");
  }
  if (readySeeds.length > 0) {
    parts.push(
      "## Threads that could pay off soon (callback-ready — tease as vibe, never as promise)",
    );
    for (const s of readySeeds.slice(0, 3)) parts.push(`- ${s.description}`);
    parts.push("");
  }
  parts.push("Now write the yokoku.");

  return collectNarration("yokoku", tier, blocks.system, parts.join("\n"), campaignId);
}

const MEMO_SYSTEM =
  "You are a narrative continuity director writing a concise session memo (max 400 words) for the next session's planning. Cover: arc position and momentum, seeds ready for payoff, NPCs who deserve a spotlight scene, creative decisions made this session, and open threads to carry forward. Use exactly these headers: Arc Status, Ready Payoffs, NPC Spotlight Debt, Carry Forward. This is internal planning prose — never player-facing.";

/** v3 director memo (judgment tier, Learned-layer bookkeeping). */
async function composeMemo(
  db: Db,
  campaignId: string,
  tier: TierSelection,
  currentTurn: number,
): Promise<string | undefined> {
  const [arc, readySeeds, direction, npcRows] = await Promise.all([
    getActiveArc(db, campaignId),
    callbackReadySeeds(db, campaignId, currentTurn),
    loadDirectionState(db, campaignId),
    db
      .select({ name: entities.name, state: entities.state })
      .from(entities)
      .where(
        and(
          eq(entities.campaignId, campaignId),
          eq(entities.entityType, "npc"),
          notTombstoned(entities),
        ),
      ),
  ]);

  const spotlight = npcRows
    .map((r) => ({ name: r.name, debt: spotlightDebtOf(r.state) }))
    .filter((r) => r.debt >= 2)
    .sort((a, b) => b.debt - a.debt)
    .slice(0, 5);

  const parts: string[] = [];
  parts.push(
    arc
      ? `Arc: ${arc.name} | Phase: ${arc.phase} | Dramatic question: ${arc.dramaticQuestion}`
      : "Arc: (none planned yet)",
  );
  parts.push(`Tension: ${direction.tension_level.toFixed(2)} (0 calm … 1 breaking point)`);
  parts.push(
    direction.director_notes.length > 0
      ? `Director notes this session:\n${direction.director_notes.map((n) => `- ${n}`).join("\n")}`
      : "Director notes this session: none",
  );
  parts.push(
    readySeeds.length > 0
      ? `Seeds ready for payoff:\n${readySeeds
          .slice(0, 8)
          .map((s) => `- ${s.description}`)
          .join("\n")}`
      : "Seeds ready for payoff: none",
  );
  parts.push(
    spotlight.length > 0
      ? `NPCs carrying spotlight debt:\n${spotlight
          .map((s) => `- ${s.name} (debt ${s.debt})`)
          .join("\n")}`
      : "NPCs carrying spotlight debt: none tracked",
  );

  const { memo } = await callJudgment(tier, {
    name: "session_memo",
    schema: z.object({ memo: z.string() }),
    system: MEMO_SYSTEM,
    prompt: parts.join("\n\n"),
    effort: "medium",
    maxTokens: 8000,
    campaignId,
  });
  const trimmed = memo.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const JOURNAL_SYSTEM =
  "You are the voice calibration system for an AI narrator. Write a short style annotation (max 300 words) capturing: the prose register used this session, recurring imagery, phrases that landed well, tone calibration notes from any player feedback, and any voice adjustments to carry forward. Write in the SECOND PERSON, e.g. 'Your prose this session favored…'. This is internal calibration — never player-facing.";

/** v3 KA voice journal (judgment tier, Learned-layer bookkeeping). */
async function composeVoiceJournal(
  db: Db,
  campaignId: string,
  tier: TierSelection,
): Promise<string | undefined> {
  const [narrations, direction, prior] = await Promise.all([
    db
      .select({ narration: episodicRecords.narration })
      .from(episodicRecords)
      .where(and(eq(episodicRecords.campaignId, campaignId), notTombstoned(episodicRecords)))
      .orderBy(desc(episodicRecords.turnNumber))
      .limit(5),
    loadDirectionState(db, campaignId),
    db
      .select({ voiceJournal: sessionRecords.voiceJournal })
      .from(sessionRecords)
      .where(and(eq(sessionRecords.campaignId, campaignId), notTombstoned(sessionRecords)))
      .orderBy(desc(sessionRecords.sessionNumber))
      .limit(1),
  ]);

  const sample = [...narrations]
    .reverse()
    .map((n) => n.narration)
    .join("\n\n")
    .slice(-1500);

  const parts: string[] = [];
  const priorJournal = prior[0]?.voiceJournal;
  if (priorJournal) parts.push(`Previous voice journal:\n${priorJournal}`);
  if (direction.voice_patterns.length > 0) {
    parts.push(
      `Voice patterns noted this session:\n${direction.voice_patterns.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  if (sample.trim()) parts.push(`Recent narration from this session:\n${sample}`);
  if (parts.length === 0) parts.push("No narration or feedback recorded this session.");

  const { journal } = await callJudgment(tier, {
    name: "voice_journal",
    schema: z.object({ journal: z.string() }),
    system: JOURNAL_SYSTEM,
    prompt: parts.join("\n\n"),
    effort: "medium",
    maxTokens: 8000,
    campaignId,
  });
  const trimmed = journal.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function spotlightDebtOf(state: unknown): number {
  if (state && typeof state === "object" && "spotlightDebt" in state) {
    const v = (state as { spotlightDebt?: unknown }).spotlightDebt;
    return typeof v === "number" ? v : 0;
  }
  return 0;
}

function logComposerFailure(what: string, campaignId: string, err: unknown): void {
  console.warn(`[session] ${what} composition failed (non-fatal)`, {
    campaignId,
    error: err instanceof Error ? err.message : String(err),
  });
}
