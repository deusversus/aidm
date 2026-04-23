import { type RouterDeps, type RouterInput, routePlayerMessage } from "@/lib/agents";
import { renderVoicePatternsJournal } from "@/lib/agents/director";
import { type KeyAnimatorEvent, runKeyAnimator } from "@/lib/agents/key-animator";
import type { CompositionMode } from "@/lib/agents/scale-selector-agent";
import { type AgentLogger, defaultLogger } from "@/lib/agents/types";
import { judgeOutcomeWithValidation } from "@/lib/agents/validator";
import type { WorldBuilderFlag } from "@/lib/agents/world-builder";
import type { Db } from "@/lib/db";
import {
  detectStaleConstructions,
  pickStyleDrift,
  renderStyleDriftDirective,
  renderVocabFreshnessAdvisory,
} from "@/lib/ka/diversity";
import { extractNames } from "@/lib/ka/portraits";
import { selectSakugaMode } from "@/lib/ka/sakuga";
import { getPrompt } from "@/lib/prompts";
import {
  type CampaignProviderConfig,
  anthropicFallbackConfig,
  validateCampaignProviderConfig,
} from "@/lib/providers";
import { assembleSessionContextBlocks } from "@/lib/rules/context-blocks";
import { assembleSessionRuleLibraryGuidance, getBeatCraftGuidance } from "@/lib/rules/library";
import { campaigns, characters, npcs, profiles, turns } from "@/lib/state/schema";
import { type AidmSpanHandle, type AidmToolContext, invokeTool } from "@/lib/tools";
import { CampaignSettings } from "@/lib/types/campaign-settings";
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
 * Render Block 4's `{{player_assertion}}` slot from the router's
 * `wbAssertion` payload (WB reshape commit). Returns an empty string
 * when no assertion fired — Block 4 renders normally with the slot
 * collapsed. When present, gives KA the assertion text, a compact
 * entity summary, and any flagged craft concerns so the narration
 * knows what's been established + what to handle carefully.
 */
function renderPlayerAssertionBlock(
  wbAssertion: import("@/lib/agents").WbAssertionPayload | undefined,
): string {
  if (!wbAssertion) return "";
  const lines: string[] = [];
  lines.push("### Player worldbuilding assertion (treat as established canon)");
  lines.push("");
  lines.push(`> ${wbAssertion.assertion}`);
  lines.push("");
  if (wbAssertion.entityUpdates.length > 0) {
    lines.push("Entities established by this assertion:");
    for (const e of wbAssertion.entityUpdates) {
      const primary = e.personality ?? e.description ?? e.details ?? "(no detail)";
      lines.push(`- **${e.name}** (${e.kind}): ${primary}`);
    }
    lines.push("");
  }
  if (wbAssertion.flags.length > 0) {
    // Flags are editorial notes FOR THE AUTHOR, rendered in the
    // sidebar. We still surface them to KA so the narration can
    // handle stakes-dissolving moves with extra care — flagged
    // assertions are canon, but KA knows to tread thoughtfully.
    lines.push("Editor flags on this assertion (non-blocking):");
    for (const f of wbAssertion.flags) {
      if (f.kind === "voice_fit") {
        lines.push(`- **voice_fit**: ${f.evidence} — suggestion: ${f.suggestion}`);
      } else if (f.kind === "stakes_implication") {
        lines.push(`- **stakes_implication**: ${f.evidence} — dissolves: ${f.what_dissolves}`);
      } else if (f.kind === "internal_consistency") {
        lines.push(`- **internal_consistency**: ${f.evidence} — contradicts: ${f.contradicts}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "Narrate forward with the assertion as canon — weave it in without meta-authorial acknowledgment. The fact is simply true in the fiction now.",
  );
  return lines.join("\n");
}

/**
 * Tiered memory retrieval budget (§9 — v3 0/3/6/9 ladder).
 *
 * KA's semantic retrieval gets progressively larger as epicness rises.
 * Intent + special_conditions shape the budget too: COMBAT floors at
 * Tier 2 (combat without continuity reads flat), special_conditions
 * bump up a tier (sakuga triggers warrant extra context), and a trivial
 * action gate drops the budget to 0 for low-stakes non-consequential
 * moves regardless of accidental epicness noise.
 *
 * Thresholds match v3's calibration exactly (0.3 / 0.6 breakpoints, not
 * 0.25 / 0.5 / 0.75). Commit 8's golden-turn evals assume these bounds.
 *
 * This is an advisory — KA sees the budget in Block 4 and chooses how
 * aggressively to query the semantic layer itself via MCP. Pre-retrieval
 * would invert the KA-as-orchestrator design.
 */
export function retrievalBudget(epicness: number, intent: IntentOutput): 0 | 3 | 6 | 9 {
  // Trivial action gate (v3 `is_trivial_action`). Low-epicness inventory
  // checks, pocket-rummages, "I look around" — zero semantic hits even
  // if special_conditions would otherwise bump.
  const consequentialIntents = new Set(["COMBAT", "ABILITY", "SOCIAL"]);
  const trivial =
    !consequentialIntents.has(intent.intent) &&
    epicness < 0.2 &&
    intent.special_conditions.length === 0;
  if (trivial) return 0;

  // v3-verbatim tier ladder. 0.3 / 0.6 are the load-bearing breakpoints.
  let tier = epicness < 0.2 ? 0 : epicness <= 0.3 ? 1 : epicness <= 0.6 ? 2 : 3;
  // COMBAT floors at Tier 2 — combat without continuity reads flat.
  if (intent.intent === "COMBAT" && tier < 2) tier = 2;
  // Special conditions bump the tier (sakuga triggers warrant more context).
  if (intent.special_conditions.length > 0 && tier < 3) tier += 1;
  const ladder = [0, 3, 6, 9] as const;
  return ladder[tier] ?? 0;
}

/**
 * Parse a PowerTier string ("T1"–"T10") into its integer form.
 * T1 = most powerful (omnipotent), T10 = weakest (human baseline) — so
 * a HIGHER integer means a WEAKER tier. Returns null for malformed input
 * so callers can fall back to `not_applicable` rather than crash.
 */
function parsePowerTier(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^T(\d+)$/);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  if (Number.isNaN(n) || n < 1 || n > 10) return null;
  return n;
}

/**
 * Effective per-turn composition mode (§7.3 scale-selector, deterministic
 * compute — not a model call). v3's scale-selector reframed stakes when
 * attacker/defender tier gap was wide: a Tier 3 hero against a Tier 9
 * mook narrates differently than Tier 8 vs Tier 8. Without this, OJ +
 * KA see the profile's default mode regardless of what's actually on
 * stage, and the "OP protagonist reframes onto meaning not survival"
 * machinery is silently inert.
 *
 * Returns `not_applicable` for non-combat intents or when either
 * participant's tier can't be determined — the fallback is safer than
 * guessing.
 */
export async function computeEffectiveCompositionMode(
  db: Db,
  campaignId: string,
  character: typeof characters.$inferSelect | null,
  intent: IntentOutput,
  scene: { present_npcs?: string[] | null } | undefined,
): Promise<CompositionMode> {
  if (intent.intent !== "COMBAT" && intent.intent !== "ABILITY") {
    return "not_applicable";
  }
  const attackerTier = parsePowerTier(character?.powerTier);
  if (attackerTier === null) return "not_applicable";

  // Defender lookup: prefer explicit intent.target; fall back to the
  // first present NPC (rough heuristic — works for two-party scenes).
  const defenderName = intent.target ?? scene?.present_npcs?.[0];
  if (!defenderName) return "not_applicable";

  const [npcRow] = await db
    .select({ powerTier: npcs.powerTier })
    .from(npcs)
    .where(and(eq(npcs.campaignId, campaignId), eq(npcs.name, defenderName)))
    .limit(1);
  const defenderTier = parsePowerTier(npcRow?.powerTier);
  if (defenderTier === null) return "not_applicable";

  // diff > 0 means defender is a WEAKER tier (higher integer); attacker
  // is overpowered relative to them. v3 thresholds: +3 → op_dominant,
  // +2 → blended, else → standard.
  const diff = defenderTier - attackerTier;
  if (diff >= 3) return "op_dominant";
  if (diff === 2) return "blended";
  return "standard";
}

/**
 * Resolve the campaign's per-turn model context from the loaded
 * settings jsonb. Post-M1.5 campaigns carry `provider` + `tier_models`
 * (via `CampaignSettings`); legacy rows that slipped past the Commit-B
 * migration fall back to `anthropicFallbackConfig()` so the turn
 * continues rather than erroring. If the config is present but
 * invalid (e.g. a model the provider doesn't support), the throw
 * surfaces immediately — silent fallback on invalid config would mask
 * a misconfiguration.
 *
 * Silent-fallback logging: the two fallback paths (parse failure +
 * half-migrated row) each emit a `warn` log via the injected logger.
 * Otherwise a Sonnet-configured campaign with a corrupted
 * `overrides` field would quietly narrate on Opus with nothing in the
 * trace explaining the regression.
 */
export function resolveModelContext(
  settingsJson: unknown,
  logger: AgentLogger = defaultLogger,
): CampaignProviderConfig {
  const parsed = CampaignSettings.safeParse(settingsJson ?? {});
  if (!parsed.success) {
    logger(
      "warn",
      "resolveModelContext: settings parse failed; falling back to Anthropic defaults",
      {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    );
    return anthropicFallbackConfig();
  }
  const { provider, tier_models } = parsed.data;
  if (!provider || !tier_models) {
    logger(
      "warn",
      "resolveModelContext: settings lacks provider or tier_models; falling back to Anthropic defaults",
      { has_provider: !!provider, has_tier_models: !!tier_models },
    );
    return anthropicFallbackConfig();
  }
  const config: CampaignProviderConfig = { provider, tier_models };
  validateCampaignProviderConfig(config); // throws if misconfigured
  return config;
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
  /**
   * Inject a mock `routePlayerMessage` in tests. Lets us drive deterministic
   * verdicts without having to mock the three sub-agents (IntentClassifier,
   * OverrideHandler, WorldBuilder) + the two structured-runner providers
   * behind them.
   */
  routeFn?: typeof routePlayerMessage;
}

export type TurnWorkflowEvent =
  | {
      type: "routed";
      verdictKind: "continue" | "meta" | "override" | "worldbuilder";
      /** In-character prose to surface to the player immediately (WB-CLARIFY, override ack). Null for `continue`. */
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
      /**
       * Route verdict kind — tells the SSE route handler whether to fire
       * Chronicler. At M1 Chronicler runs only on `continue` turns
       * (player-driven narrative with intent + outcome). META / OVERRIDE /
       * WORLDBUILDER (CLARIFY only) short-circuits skip Chronicler.
       * WB-ACCEPT / WB-FLAG arrive on the continue path with wbAssertion
       * (WB reshape commit) and DO chronicle.
       */
      verdictKind: "continue" | "meta" | "override" | "worldbuilder";
      /** IntentClassifier's output for the message. Required — every done has one. */
      intent: IntentOutput;
      /** OJ verdict. Null for short-circuit paths (no outcome judgment ran). */
      outcome: OutcomeOutput | null;
      /**
       * Non-blocking WorldBuilder flags for the player's sidebar UI
       * (WB reshape commit). Empty when WB didn't fire or the
       * assertion had no craft concerns. Three-kind discriminated
       * union: voice_fit | stakes_implication | internal_consistency.
       */
      flags: WorldBuilderFlag[];
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
    style_drift_used: string | null;
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
      style_drift_used: turns.styleDriftUsed,
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
    logger("warn", "runTurn: advisory lock timeout", {
      campaignId: input.campaignId,
      userId: input.userId,
      timeoutMs: ADVISORY_LOCK_TIMEOUT_MS,
    });
    yield {
      type: "error",
      message: "Another turn is in progress for this campaign. Try again in a moment.",
    };
    return;
  }

  try {
    const ctx = await loadTurnContext(db, input.campaignId, input.userId);
    const settings = (ctx.campaignRow.settings ?? {}) as Record<string, unknown>;
    // Resolve per-campaign provider + tier_models once and thread it
    // through every sub-agent call on this turn. A misconfigured
    // campaign (e.g. selecting Google before M3.5) throws here and
    // surfaces as a terminal turn error to the player.
    const modelContext = resolveModelContext(ctx.campaignRow.settings, logger);

    // Correlation fields for every log emitted during this turn.
    // Passed through deps so sub-agents don't have to plumb the
    // fields individually — `logger("warn", msg, { ...logContext, extra })`.
    const logContext = {
      campaignId: input.campaignId,
      userId: input.userId,
      turnNumber: ctx.nextTurnNumber,
    };
    logger("info", "runTurn: start", {
      ...logContext,
      phase: ctx.campaignRow.phase,
      provider: modelContext.provider,
    });

    // Per-turn prompt-fingerprint accumulator. Every agent call that
    // passes a `promptId` records its composed-prompt fingerprint here.
    // Persisted on the turn row at the end so voice regressions are
    // traceable to the exact commit that changed any prompt file.
    const promptFingerprints: Record<string, string> = {};
    const recordPrompt = (agentName: string, fingerprint: string): void => {
      promptFingerprints[agentName] = fingerprint;
    };

    // Per-turn pre-pass cost accumulator (Commit 9). Every _runner.ts-
    // based consultant (IntentClassifier, OJ, Validator, WB, OverrideHandler,
    // Scenewright, KA consultants, Chronicler's RelationshipAnalyzer)
    // calls this after each attempt with its accumulated USD cost.
    //
    // KA + Chronicler themselves bypass this — the Agent SDK returns
    // its own `total_cost_usd` at the result event, which subsumes
    // their consultants. We add their SDK-reported cost directly to
    // `turnCostUsd` below.
    let prePassCostUsd = 0;
    const recordCost = (_agentName: string, costUsd: number): void => {
      prePassCostUsd += costUsd;
    };

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
    const routeFn = deps.routeFn ?? routePlayerMessage;
    const verdict = await routeFn(routerInput, {
      trace: deps.trace,
      logger,
      logContext,
      modelContext,
      recordPrompt,
      recordCost,
      ...deps.routerDeps,
    });
    logger("info", "runTurn: routed", {
      ...logContext,
      verdictKind: verdict.kind,
      intent: verdict.intent.intent,
      epicness: verdict.intent.epicness,
    });

    // Short-circuit branches: META / OVERRIDE / WB-CLARIFY.
    //
    // WB reshape note: ACCEPT / FLAG used to live here too. The reshape
    // moved them onto the `continue` path (router emits `wbAssertion`
    // on the continue verdict) so KA narrates normally with the
    // assertion as Block-4 canon. Only CLARIFY — genuine physical
    // ambiguity — still short-circuits with the clarifying question.
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
          promptFingerprints,
          portraitMap: {},
        })
        .returning({ id: turns.id });
      logger("info", "runTurn: short-circuit persisted", {
        ...logContext,
        verdictKind: verdict.kind,
        turnId: persisted?.id ?? "",
      });

      // ---------------------------------------------------------------
      // Short-circuit persistence (v3-parity audit fix, 2026-04-21).
      //
      // Router kinds MUST bind state; "classify then forget" was the
      // original regression. Two paths still landing here:
      //
      //   OVERRIDE → append to campaign.settings.overrides (so next
      //     turn's priorOverrides reads it back + Block 4 surfaces it).
      //   META → no persistence at Phase 1 (meta conversation loop
      //     lands at Phase 5 of v3-audit-closure).
      //   WB-CLARIFY → no persistence (player's answer will reshape
      //     the assertion; persisting now would commit to a draft
      //     the player is about to revise).
      //
      // WB-ACCEPT / WB-FLAG no longer short-circuit — their entity
      // persistence moved onto the continue branch below, so KA's
      // tool calls see the new entities when it narrates forward.
      // ---------------------------------------------------------------
      if (verdict.kind === "override" && verdict.override.mode === "override") {
        // Schema allows `category: null` even under mode="override" (the
        // fallback builder at override-handler.ts:85 defaults to
        // NARRATIVE_DEMAND, but a structured-output anomaly could still
        // yield null). Default to NARRATIVE_DEMAND here rather than
        // silently dropping the override — the player saw an ack; state
        // MUST reflect what they asked for.
        const category = verdict.override.category ?? "NARRATIVE_DEMAND";
        const newOverride = {
          id: crypto.randomUUID(),
          category,
          value: verdict.override.value,
          scope: verdict.override.scope,
          created_at: new Date().toISOString(),
        };
        const existing = Array.isArray(settings.overrides) ? settings.overrides : [];
        const newSettings = { ...settings, overrides: [...existing, newOverride] };
        await db
          .update(campaigns)
          .set({ settings: newSettings })
          .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)));
      }

      // WB-CLARIFY no longer persists entities (the player is about to
      // revise the assertion; persisting now would commit to a draft).
      // WB-ACCEPT / WB-FLAG persistence moved to the continue branch
      // below (happens BEFORE KA runs so KA's tool calls see new rows).

      yield {
        type: "done",
        turnId: persisted?.id ?? "",
        turnNumber: ctx.nextTurnNumber,
        narrative: responseText,
        ttftMs: null,
        totalMs: 0,
        costUsd: null,
        portraitNames: [],
        verdictKind: verdict.kind,
        intent: verdict.intent,
        outcome: null,
        flags: [],
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
    // WB reshape: ACCEPT / FLAG now arrive on the continue path with a
    // `wbAssertion` payload. Persist the entities BEFORE KA runs so the
    // new NPC/location/faction rows are visible to KA's tool calls
    // (e.g. `list_known_npcs` returning the NPC the player just
    // declared). Flags accumulate here and ride along to the done event;
    // CLARIFY never reaches this branch.
    // -------------------------------------------------------------------
    const wbAssertion = verdict.wbAssertion;
    if (wbAssertion) {
      const turnNum = ctx.nextTurnNumber;
      const baseToolCtx: AidmToolContext = {
        campaignId: input.campaignId,
        userId: input.userId,
        db,
        trace: deps.trace,
        logger,
        logContext,
      };
      for (const update of wbAssertion.entityUpdates) {
        try {
          if (update.kind === "npc") {
            await invokeTool(
              "register_npc",
              {
                name: update.name,
                role: update.role,
                personality: update.personality ?? update.details ?? "",
                goals: update.goals,
                secrets: update.secrets,
                faction: update.faction ?? null,
                visual_tags: update.visual_tags,
                knowledge_topics: update.knowledge_topics,
                power_tier: update.power_tier,
                ensemble_archetype: update.ensemble_archetype ?? null,
                first_seen_turn: turnNum,
                last_seen_turn: turnNum,
              },
              baseToolCtx,
            );
          } else if (update.kind === "location") {
            const locDetails: Record<string, unknown> = {};
            if (update.description || update.details) {
              locDetails.description = update.description ?? update.details;
            }
            if (update.atmosphere) locDetails.atmosphere = update.atmosphere;
            if (update.notable_features) locDetails.notable_features = update.notable_features;
            if (update.faction_owner) locDetails.faction_owner = update.faction_owner;
            await invokeTool(
              "register_location",
              {
                name: update.name,
                details: locDetails,
                first_seen_turn: turnNum,
                last_seen_turn: turnNum,
              },
              baseToolCtx,
            );
          } else if (update.kind === "faction") {
            const factionDetails: Record<string, unknown> = {};
            if (update.description || update.details) {
              factionDetails.description = update.description ?? update.details;
            }
            if (update.leadership) factionDetails.leadership = update.leadership;
            if (update.allegiance) factionDetails.allegiance = update.allegiance;
            if (update.goals) factionDetails.goals = update.goals;
            await invokeTool(
              "register_faction",
              { name: update.name, details: factionDetails },
              baseToolCtx,
            );
          } else if (update.kind === "fact") {
            await invokeTool(
              "write_semantic_memory",
              {
                category: "fact",
                content: `${update.name}: ${update.details}`,
                heat: 80,
                turn_number: turnNum,
              },
              baseToolCtx,
            );
          } else if (update.kind === "item") {
            const itemContent = update.description
              ? `${update.name}: ${update.description}`
              : `${update.name}: ${update.details}`;
            await invokeTool(
              "write_semantic_memory",
              {
                category: "item",
                content: itemContent,
                heat: 70,
                turn_number: turnNum,
              },
              baseToolCtx,
            );
          }
        } catch (err) {
          // Best-effort. A failed write on one entity shouldn't block
          // the rest or stop KA from narrating forward.
          logger("warn", "WB entity persist failed", {
            ...logContext,
            kind: update.kind,
            name: update.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // Effective composition mode (§7.3 scale-selector — deterministic
    // compute, not a model call). Threads into OJ context + Block 1 +
    // Block 4. v3-parity: without this every turn sees "standard" and
    // OP protagonist reframing is silently inert.
    // -------------------------------------------------------------------
    const scene = (settings.world_state ?? {}) as {
      location?: string;
      situation?: string;
      time_context?: string;
      present_npcs?: string[];
    };
    const compositionMode = await computeEffectiveCompositionMode(
      db,
      input.campaignId,
      ctx.characterRow,
      verdict.intent,
      scene,
    );

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
          compositionMode,
          activeOverrides:
            routerInput.priorOverrides?.map((o) => ({
              category: o.category,
              value: o.value,
            })) ?? [],
        },
        { trace: deps.trace, logger, logContext, modelContext, recordPrompt, recordCost },
      );
      outcome = judgedOutcome;
    }

    const sakuga = selectSakugaMode(verdict.intent, outcome);
    // Sakuga fragments are pulled at render-time (not {{include:}}'d
    // into Block 4), so editing sakuga_choreographic.md wouldn't
    // change block_4_dynamic's fingerprint. Record separately so the
    // audit trail actually catches voice regressions caused by
    // fragment edits.
    if (sakuga) {
      try {
        recordPrompt(`sakuga:${sakuga.mode}`, getPrompt(sakuga.promptId).fingerprint);
      } catch {
        /* non-fatal — narration proceeds with fragment content already loaded */
      }
    }

    // Narrative diversity machinery (§7.4). Both outputs land in Block 4
    // as soft advisories. Style-drift convergence check skips the
    // directive when recent openings already vary; vocab-freshness
    // scans the last N narrations for construction-level repetition.
    const recentNarrations = ctx.workingMemory.map((t) => t.narrative_text);
    // Last 3 style-drift directives actually injected — suppresses
    // repeat-in-a-row selection. Phase 7 polish (MINOR #15). Filter
    // null + coerce to the StyleDrift union type at the call site.
    const recentlyUsedDrifts = ctx.workingMemory
      .slice(-3)
      .map((t) => t.style_drift_used)
      .filter((d): d is string => d !== null) as Array<import("@/lib/ka/diversity").StyleDrift>;
    const styleDrift = pickStyleDrift({
      recentNarrations,
      intent: verdict.intent,
      narrativeWeight: outcome?.narrative_weight,
      recentlyUsed: recentlyUsedDrifts,
    });

    // Build the vocab-freshness whitelists at the call site. Without these
    // the detector false-positives on character names ("Spike Spiegel"
    // tripping simile_like_a) and power-system jargon ("Nen" flagged as
    // a construction). v3-parity: the Sets were passed verbatim; v4 wired
    // the detector but left the inputs empty — this closes that gap.
    //
    // Bounded at 1000 names — the detector's proper-noun set is O(n) in
    // match iteration, and a campaign with >1000 NPCs is implausible.
    const npcCatalog = await db
      .select({ name: npcs.name })
      .from(npcs)
      .where(eq(npcs.campaignId, input.campaignId))
      .limit(1000);
    const properNouns = new Set<string>([
      ...(ctx.characterRow ? [ctx.characterRow.name] : []),
      ...npcCatalog.map((n) => n.name),
      ...(ctx.profile.ip_mechanics.voice_cards?.map((v) => v.name) ?? []),
    ]);
    const jargonAllowlist = new Set<string>([
      ...(ctx.profile.ip_mechanics.power_system?.limitations
        ?.split(/\s+/)
        .map((w) => w.toLowerCase()) ?? []),
      // Tier names tokenized in case canon uses multi-word tiers
      // ("high-rank executor", "s-rank hunter"). The vocab detector
      // matches single lowercased tokens, not the full string.
      ...(ctx.profile.ip_mechanics.power_system?.tiers?.flatMap((t) =>
        t.split(/\s+/).map((w) => w.toLowerCase()),
      ) ?? []),
      ...((ctx.profile.ip_mechanics.author_voice?.sentence_patterns ?? []).flatMap((p) =>
        p.split(/\s+/).map((w) => w.toLowerCase()),
      ) ?? []),
    ]);
    const staleConstructions = detectStaleConstructions({
      recentNarrations,
      properNouns,
      jargonAllowlist,
    });

    const toolContext: AidmToolContext = {
      campaignId: input.campaignId,
      userId: input.userId,
      db,
      trace: deps.trace,
      logger,
      logContext,
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
    const arcPhase = arcPlan.arc_phase ?? null;
    // Beat-craft guidance for the current arc phase (v3-parity Phase 7
    // MINOR #18). Null-safe: missing phase → null → Block 4 fallback.
    const arcPhaseCraft = arcPhase ? await getBeatCraftGuidance(db, arcPhase) : null;
    const budget = retrievalBudget(verdict.intent.epicness, verdict.intent);

    // Rule-library bundle for this session (v3-parity, Phase 2C of v3-audit
    // closure). Pulled fresh each turn at M1 — four small DB roundtrips, a
    // few KB of content. Will move to campaign.settings.session_cache in
    // Phase 7 polish. Graceful degradation: lookup misses produce an empty
    // section, never an error.
    const sessionRuleLibrary = await assembleSessionRuleLibraryGuidance(db, {
      profile: ctx.profile,
      activeDna: settings.active_dna as never,
      activeComposition: settings.active_composition as never,
      characterPowerTier: ctx.characterRow?.powerTier ?? null,
      campaignId: input.campaignId,
    });

    // Context-blocks bundle for Block 2 (v3-parity Phase 3C). Pulls all
    // `active` blocks for the campaign; ordered arc → thread → quest →
    // faction → location → npc; capped at ~10 blocks for token budget.
    // Chronicler drives block creation/updates via update_context_block
    // tool; blocks accumulate organically through play.
    const sessionContextBlocks = await assembleSessionContextBlocks(db, input.campaignId);

    const runKa = deps.runKa ?? runKeyAnimator;
    const kaIter = runKa(
      {
        profile: ctx.profile,
        campaign: {
          active_dna: settings.active_dna as never,
          active_composition: settings.active_composition as never,
          arc_override: settings.arc_override as never,
        },
        modelContext,
        workingMemory: ctx.workingMemory,
        compaction: [],
        block4: {
          player_message: input.playerMessage,
          intent: verdict.intent,
          outcome,
          active_composition_mode: compositionMode,
          arc_phase_craft: arcPhaseCraft ?? undefined,
          retrieval_budget: budget,
          sakuga_injection: sakuga?.fragment,
          style_drift_directive: renderStyleDriftDirective(styleDrift),
          vocabulary_freshness_advisory: renderVocabFreshnessAdvisory(staleConstructions),
          director_notes: directorNotes,
          // v3-parity format: `[CATEGORY] value` so KA sees the semantic
          // hint (NPC_PROTECTION vs CONTENT_CONSTRAINT vs NARRATIVE_DEMAND
          // vs TONE_REQUIREMENT). Phase 6C of v3-audit closure — dropping
          // the category tag silently loses meaning KA needs to narrate
          // faithfully.
          player_overrides:
            routerInput.priorOverrides?.map((o) => `[${o.category}] ${o.value}`) ?? [],
          // WB reshape: when WB accepted or flagged an assertion, inject
          // the player-assertion section so KA narrates with it as canon.
          // Empty string on non-WB turns so the block flows as before.
          player_assertion: renderPlayerAssertionBlock(wbAssertion),
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
        activeCompositionMode: compositionMode,
        sessionRuleLibrary: sessionRuleLibrary || undefined,
        sessionContextBlocks: sessionContextBlocks || undefined,
        voicePatternsJournal: voicePatternsJournal || undefined,
        toolContext,
        abortController: input.abort,
      },
      // KA does NOT receive `recordCost` — the Agent SDK reports a
      // SESSION total_cost_usd that already subsumes KA's consultants.
      // Passing `recordCost` here would double-count if a future KA
      // path ever routed an internal call through `_runner.ts`.
      { trace: deps.trace, logger, logContext, recordPrompt },
    );

    let narrative = "";
    let ttftMs: number | null = null;
    let totalMs = 0;
    let kaCostUsd: number | null = null;

    for await (const ev of kaIter as AsyncIterable<KeyAnimatorEvent>) {
      if (ev.kind === "text") {
        narrative += ev.delta;
        yield { type: "text", delta: ev.delta };
      } else {
        ttftMs = ev.ttftMs;
        totalMs = ev.totalMs;
        kaCostUsd = ev.costUsd;
        narrative = ev.narrative;
      }
    }

    // Total pre-Chronicler turn cost: pre-pass consultants + KA's own
    // SDK-reported total_cost_usd (which subsumes KA's consultants).
    // Chronicler's cost lands later via chronicle.ts post-hoc update.
    const turnCostUsd = prePassCostUsd + (kaCostUsd ?? 0);

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
        promptFingerprints,
        portraitMap,
        costUsd: turnCostUsd.toFixed(6),
        ttftMs,
        totalMs,
        styleDriftUsed: styleDrift ?? null,
        flags: wbAssertion?.flags ?? [],
      })
      .returning({ id: turns.id });
    logger("info", "runTurn: persisted", {
      ...logContext,
      turnId: persisted?.id ?? "",
      intent: verdict.intent.intent,
      ttftMs,
      totalMs,
      costUsd: turnCostUsd,
      outcomeWeight: outcome?.narrative_weight ?? null,
      outcomeSuccess: outcome?.success_level ?? null,
      wbFlags: wbAssertion?.flags.length ?? 0,
    });

    yield {
      type: "done",
      turnId: persisted?.id ?? "",
      turnNumber: ctx.nextTurnNumber,
      narrative,
      ttftMs,
      totalMs,
      costUsd: turnCostUsd,
      portraitNames,
      verdictKind: "continue",
      intent: verdict.intent,
      outcome: outcome ?? null,
      flags: wbAssertion?.flags ?? [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger("error", "runTurn: failed", {
      campaignId: input.campaignId,
      userId: input.userId,
      error: msg,
    });
    yield { type: "error", message: msg };
  } finally {
    await releaseLock(db, input.campaignId).catch(() => {
      /* best-effort; pg will release on connection close */
    });
  }
}
