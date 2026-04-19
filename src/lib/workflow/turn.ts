import { type RouterDeps, type RouterInput, routePlayerMessage } from "@/lib/agents";
import { renderVoicePatternsJournal } from "@/lib/agents/director";
import { type KeyAnimatorEvent, runKeyAnimator } from "@/lib/agents/key-animator";
import { type AgentLogger, defaultLogger } from "@/lib/agents/types";
import { judgeOutcomeWithValidation } from "@/lib/agents/validator";
import type { Db } from "@/lib/db";
import {
  detectStaleConstructions,
  pickStyleDrift,
  renderStyleDriftDirective,
  renderVocabFreshnessAdvisory,
} from "@/lib/ka/diversity";
import { extractNames } from "@/lib/ka/portraits";
import { selectSakugaMode } from "@/lib/ka/sakuga";
import { campaigns, characters, profiles, turns } from "@/lib/state/schema";
import type { AidmSpanHandle, AidmToolContext } from "@/lib/tools";
import { Profile } from "@/lib/types/profile";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * The turn workflow — what happens between "player hit send" and "KA's
 * last token reaches the browser."
 *
 * Shape (§6.1, KA-orchestrated):
 *   1. Acquire per-campaign Postgres advisory lock (concurrent turns
 *      for the same campaign serialize; 15s timeout).
 *   2. Load campaign + profile + character + working memory (last N
 *      turn rows).
 *   3. Run the routing pre-pass (IntentClassifier → route → maybe
 *      WorldBuilder / OverrideHandler).
 *   4. If router short-circuits (META/WB-reject/WB-clarify/OVERRIDE),
 *      persist the turn row with the router's response, release the
 *      lock, and return — no KA call.
 *   5. Otherwise render the 4 KA blocks, pick sakuga mode, spawn KA.
 *   6. Stream KA deltas to the caller as they arrive. Buffer for
 *      persistence.
 *   7. On KA `final`, persist the turn row (narrative, fingerprints,
 *      cost, timing, portrait map), release the lock, yield terminal.
 *
 * Returns an async generator of events the Route Handler forwards as
 * SSE. Events are discriminated by `type`:
 *   - `routed`: emitted once after the router pre-pass runs
 *   - `text`: KA token delta
 *   - `done`: final event with persistence result
 *   - `error`: terminal error (caller closes stream)
 *
 * Persistence happens inside this function so the Route Handler
 * stays thin (auth + SSE plumbing only).
 */

const WORKING_MEMORY_TURNS = 6;
const ADVISORY_LOCK_TIMEOUT_MS = 15_000;

/**
 * Tiered memory retrieval budget (§9 — v3 0/3/6/9 ladder).
 *
 * KA's semantic retrieval gets progressively larger as epicness rises.
 * Low-stakes turns (epicness < 0.25) don't pull from semantic memory at
 * all; pivotal turns (≥ 0.75) pull up to nine candidates. This is an
 * advisory — KA sees the budget in Block 4 and chooses how aggressively
 * to query the semantic layer itself via MCP. Pre-retrieval would
 * invert the KA-as-orchestrator design.
 */
export function retrievalBudget(epicness: number): 0 | 3 | 6 | 9 {
  if (epicness >= 0.75) return 9;
  if (epicness >= 0.5) return 6;
  if (epicness >= 0.25) return 3;
  return 0;
}

/**
 * Decide whether to pre-call OutcomeJudge before KA for this turn.
 *
 * v3's cascade ran OJ for every consequential action. v4 KA is the
 * orchestrator and could call OJ itself, but giving it a mechanical
 * verdict up-front means (a) sakuga's CLIMACTIC fallback can fire,
 * (b) Block 4 renders the actual outcome for KA to narrate rather
 * than inventing one, (c) the trace shows the outcome before narration
 * so regressions are traceable to verdict vs prose. We still skip for
 * trivial turns — there's no mechanical truth to decide when the
 * player is just looking around or checking their pack.
 */
export function shouldPreJudgeOutcome(intent: IntentOutput): boolean {
  if (intent.intent === "COMBAT" || intent.intent === "ABILITY") return true;
  if (intent.intent === "SOCIAL" && intent.epicness >= 0.4) return true;
  if (intent.intent === "EXPLORATION" && intent.epicness >= 0.6) return true;
  if (intent.intent === "DEFAULT" && intent.epicness >= 0.6) return true;
  return false;
}

export interface TurnWorkflowInput {
  campaignId: string;
  userId: string;
  playerMessage: string;
  /** Optional abort signal — forwarded to KA for mid-stream cancellation. */
  abort?: AbortController;
}

export interface TurnWorkflowDeps {
  db: Db;
  trace?: AidmSpanHandle;
  logger?: AgentLogger;
  routerDeps?: RouterDeps;
  /** Inject mock KA for tests. Defaults to real KA. */
  runKa?: typeof runKeyAnimator;
}

export type TurnWorkflowEvent =
  | {
      type: "routed";
      verdictKind: "continue" | "meta" | "override" | "worldbuilder";
      /** In-character prose to surface to the player immediately (WB accept/clarify/reject, override ack). Null for `continue`. */
      response: string | null;
      turnNumber: number;
    }
  | { type: "text"; delta: string }
  | {
      type: "done";
      turnId: string;
      turnNumber: number;
      narrative: string;
      ttftMs: number | null;
      totalMs: number;
      costUsd: number | null;
      portraitNames: string[];
    }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

/** Hash a UUID into a pair of int4s for pg_advisory_lock. Stable. */
function campaignToLockKeys(campaignId: string): [number, number] {
  // Treat the UUID as 32 hex chars; fold to two 32-bit signed ints.
  const hex = campaignId.replace(/-/g, "");
  const upper = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const lower = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [upper, lower];
}

async function tryAcquireLock(db: Db, campaignId: string, timeoutMs: number): Promise<boolean> {
  const [k1, k2] = campaignToLockKeys(campaignId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(${k1}::int, ${k2}::int) AS locked`,
    );
    const row = (result.rows ?? (result as unknown as Array<{ locked: boolean }>))[0];
    if (row?.locked) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function releaseLock(db: Db, campaignId: string): Promise<void> {
  const [k1, k2] = campaignToLockKeys(campaignId);
  await db.execute(sql`SELECT pg_advisory_unlock(${k1}::int, ${k2}::int)`);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface LoadedContext {
  campaignRow: typeof campaigns.$inferSelect;
  profile: Profile;
  characterRow: typeof characters.$inferSelect | null;
  workingMemory: Array<{
    turn_number: number;
    player_message: string;
    narrative_text: string;
  }>;
  nextTurnNumber: number;
}

async function loadTurnContext(db: Db, campaignId: string, userId: string): Promise<LoadedContext> {
  const [campaignRow] = await db
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)),
    )
    .limit(1);
  if (!campaignRow) throw new Error("Campaign not found");

  const profileRefs = campaignRow.profileRefs as string[];
  const primarySlug = profileRefs[0];
  if (!primarySlug) throw new Error("Campaign has no profile_refs");
  const [profileRow] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.slug, primarySlug))
    .limit(1);
  if (!profileRow) throw new Error(`Profile ${primarySlug} not found`);
  const profile = Profile.parse(profileRow.content);

  const [characterRow] = await db
    .select()
    .from(characters)
    .where(eq(characters.campaignId, campaignId))
    .limit(1);

  const recent = await db
    .select({
      turn_number: turns.turnNumber,
      player_message: turns.playerMessage,
      narrative_text: turns.narrativeText,
    })
    .from(turns)
    .where(eq(turns.campaignId, campaignId))
    .orderBy(desc(turns.turnNumber))
    .limit(WORKING_MEMORY_TURNS);

  const workingMemory = recent.slice().reverse();
  const nextTurnNumber =
    workingMemory.length > 0 ? (workingMemory[workingMemory.length - 1]?.turn_number ?? 0) + 1 : 1;

  return {
    campaignRow,
    profile,
    characterRow: characterRow ?? null,
    workingMemory,
    nextTurnNumber,
  };
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

export async function* runTurn(
  input: TurnWorkflowInput,
  deps: TurnWorkflowDeps,
): AsyncGenerator<TurnWorkflowEvent, void, void> {
  const logger = deps.logger ?? defaultLogger;
  const { db } = deps;

  const acquired = await tryAcquireLock(db, input.campaignId, ADVISORY_LOCK_TIMEOUT_MS);
  if (!acquired) {
    yield {
      type: "error",
      message: "Another turn is in progress for this campaign. Try again in a moment.",
    };
    return;
  }

  try {
    const ctx = await loadTurnContext(db, input.campaignId, input.userId);
    const settings = (ctx.campaignRow.settings ?? {}) as Record<string, unknown>;

    // -------------------------------------------------------------------
    // Route pre-pass
    // -------------------------------------------------------------------
    const routerInput: RouterInput = {
      playerMessage: input.playerMessage,
      recentTurnsSummary: ctx.workingMemory
        .slice(-3)
        .map((t) => `Turn ${t.turn_number}: ${t.narrative_text.slice(0, 200)}`)
        .join("\n"),
      campaignPhase: ctx.campaignRow.phase === "sz" ? "sz" : "playing",
      canonicalityMode: "inspired", // M1 default; M2 sets this from SZ output
      characterSummary: ctx.characterRow
        ? `${ctx.characterRow.name} (${ctx.characterRow.powerTier}): ${ctx.characterRow.concept}`
        : "",
      activeCanonRules: [],
      priorOverrides: Array.isArray(settings.overrides)
        ? (settings.overrides as Array<{
            id: string;
            category:
              | "NPC_PROTECTION"
              | "CONTENT_CONSTRAINT"
              | "NARRATIVE_DEMAND"
              | "TONE_REQUIREMENT";
            value: string;
            scope: "campaign" | "session" | "arc";
          }>)
        : [],
    };
    const verdict = await routePlayerMessage(routerInput, {
      trace: deps.trace,
      logger,
      ...deps.routerDeps,
    });

    // Short-circuit branches: META / OVERRIDE / WB (any decision).
    // Persist a minimal turn row with the in-character response and return.
    if (verdict.kind !== "continue") {
      const responseText =
        verdict.kind === "worldbuilder" ? verdict.verdict.response : verdict.override.ack_phrasing;
      yield {
        type: "routed",
        verdictKind: verdict.kind,
        response: responseText,
        turnNumber: ctx.nextTurnNumber,
      };
      const [persisted] = await db
        .insert(turns)
        .values({
          campaignId: input.campaignId,
          turnNumber: ctx.nextTurnNumber,
          playerMessage: input.playerMessage,
          narrativeText: responseText,
          intent: verdict.intent,
          verdictKind: verdict.kind,
          outcome: null,
          promptFingerprints: {},
          portraitMap: {},
        })
        .returning({ id: turns.id });
      yield {
        type: "done",
        turnId: persisted?.id ?? "",
        turnNumber: ctx.nextTurnNumber,
        narrative: responseText,
        ttftMs: null,
        totalMs: 0,
        costUsd: null,
        portraitNames: [],
      };
      return;
    }

    // -------------------------------------------------------------------
    // Continue branch → KA
    // -------------------------------------------------------------------
    yield {
      type: "routed",
      verdictKind: "continue",
      response: null,
      turnNumber: ctx.nextTurnNumber,
    };

    // -------------------------------------------------------------------
    // OutcomeJudge pre-pass (consequential intents only).
    // Runs BEFORE sakuga selection so the CLIMACTIC-weight fallback can
    // fire when OJ returns it. Falls back to `undefined` on skip so
    // sakuga's priority ladder still governs non-consequential turns.
    // -------------------------------------------------------------------
    let outcome: OutcomeOutput | undefined;
    if (shouldPreJudgeOutcome(verdict.intent)) {
      const canonRules = Array.isArray(settings.canon_rules)
        ? (settings.canon_rules as string[])
        : [];
      const { outcome: judgedOutcome } = await judgeOutcomeWithValidation(
        {
          intent: verdict.intent,
          playerMessage: input.playerMessage,
          characterSummary: ctx.characterRow
            ? {
                name: ctx.characterRow.name,
                power_tier: ctx.characterRow.powerTier,
                summary: ctx.characterRow.concept,
              }
            : {},
          situation: routerInput.recentTurnsSummary,
          activeConsequences: [],
        },
        {
          characterSummary: ctx.characterRow
            ? {
                name: ctx.characterRow.name,
                power_tier: ctx.characterRow.powerTier,
                summary: ctx.characterRow.concept,
              }
            : {},
          canonRules,
          compositionMode: "standard",
          activeOverrides:
            routerInput.priorOverrides?.map((o) => ({
              category: o.category,
              value: o.value,
            })) ?? [],
        },
        { trace: deps.trace, logger },
      );
      outcome = judgedOutcome;
    }

    const sakuga = selectSakugaMode(verdict.intent, outcome);

    // Narrative diversity machinery (§7.4). Both outputs land in Block 4
    // as soft advisories. Style-drift convergence check skips the
    // directive when recent openings already vary; vocab-freshness
    // scans the last N narrations for construction-level repetition.
    const recentNarrations = ctx.workingMemory.map((t) => t.narrative_text);
    const styleDrift = pickStyleDrift({
      recentNarrations,
      intent: verdict.intent,
      narrativeWeight: outcome?.narrative_weight,
      recentlyUsed: [],
    });
    const staleConstructions = detectStaleConstructions({ recentNarrations });

    const scene = (settings.world_state ?? {}) as {
      location?: string;
      situation?: string;
      time_context?: string;
      present_npcs?: string[];
    };

    const toolContext: AidmToolContext = {
      campaignId: input.campaignId,
      userId: input.userId,
      db,
      trace: deps.trace,
    };

    const voicePatternsArray = Array.isArray(
      (settings.voice_patterns as { patterns?: unknown } | undefined)?.patterns,
    )
      ? (settings.voice_patterns as { patterns: string[] }).patterns.filter(
          (p): p is string => typeof p === "string",
        )
      : [];
    const voicePatternsJournal = renderVoicePatternsJournal(voicePatternsArray);
    const directorNotes = Array.isArray(settings.director_notes)
      ? (settings.director_notes as unknown[])
          .filter((n): n is string => typeof n === "string")
          .map((n) => `- ${n}`)
          .join("\n")
      : "";
    const arcPlan = (settings.arc_plan ?? {}) as {
      current_arc?: string | null;
      arc_phase?: string | null;
      tension_level?: number | null;
    };
    const budget = retrievalBudget(verdict.intent.epicness);

    const runKa = deps.runKa ?? runKeyAnimator;
    const kaIter = runKa(
      {
        profile: ctx.profile,
        campaign: {
          active_dna: settings.active_dna as never,
          active_composition: settings.active_composition as never,
          arc_override: settings.arc_override as never,
        },
        workingMemory: ctx.workingMemory,
        compaction: [],
        block4: {
          player_message: input.playerMessage,
          intent: verdict.intent,
          outcome,
          retrieval_budget: budget,
          sakuga_injection: sakuga?.fragment,
          style_drift_directive: renderStyleDriftDirective(styleDrift),
          vocabulary_freshness_advisory: renderVocabFreshnessAdvisory(staleConstructions),
          director_notes: directorNotes,
          player_overrides: routerInput.priorOverrides?.map((o) => o.value) ?? [],
          arc_state: {
            current_arc: arcPlan.current_arc ?? null,
            arc_phase: arcPlan.arc_phase ?? null,
            tension_level: arcPlan.tension_level ?? 0.3,
          },
          active_foreshadowing: [],
          scene: {
            location: scene.location ?? null,
            situation: scene.situation ?? null,
            time_context: scene.time_context ?? null,
            present_npcs: scene.present_npcs ?? [],
          },
        },
        voicePatternsJournal: voicePatternsJournal || undefined,
        toolContext,
        abortController: input.abort,
      },
      { trace: deps.trace, logger },
    );

    let narrative = "";
    let ttftMs: number | null = null;
    let totalMs = 0;
    let costUsd: number | null = null;

    for await (const ev of kaIter as AsyncIterable<KeyAnimatorEvent>) {
      if (ev.kind === "text") {
        narrative += ev.delta;
        yield { type: "text", delta: ev.delta };
      } else {
        ttftMs = ev.ttftMs;
        totalMs = ev.totalMs;
        costUsd = ev.costUsd;
        narrative = ev.narrative;
      }
    }

    const portraitNames = extractNames(narrative);
    const portraitMap: Record<string, string | null> = {};
    for (const n of portraitNames) portraitMap[n] = null;

    const [persisted] = await db
      .insert(turns)
      .values({
        campaignId: input.campaignId,
        turnNumber: ctx.nextTurnNumber,
        playerMessage: input.playerMessage,
        narrativeText: narrative,
        intent: verdict.intent,
        verdictKind: "continue",
        outcome: outcome ?? null,
        promptFingerprints: {},
        portraitMap,
        costUsd: costUsd === null ? null : costUsd.toFixed(6),
        ttftMs,
        totalMs,
      })
      .returning({ id: turns.id });

    yield {
      type: "done",
      turnId: persisted?.id ?? "",
      turnNumber: ctx.nextTurnNumber,
      narrative,
      ttftMs,
      totalMs,
      costUsd,
      portraitNames,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger("error", "turn workflow failed", { error: msg });
    yield { type: "error", message: msg };
  } finally {
    await releaseLock(db, input.campaignId).catch(() => {
      /* best-effort; pg will release on connection close */
    });
  }
}
