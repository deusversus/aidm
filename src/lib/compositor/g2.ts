import { maybeCompact } from "@/lib/blocks/compaction";
import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  criticalFacts,
  entities,
  entityVersions,
  episodicRecords,
  heatBoosts,
  pencilMarks,
  seeds,
  semanticMemories,
  turns,
} from "@/lib/db/schema";
import {
  accumulate,
  evaluateDirectorTrigger,
  loadDirectionState,
  runDirectorCycle,
  saveDirectionState,
} from "@/lib/direction/director";
import {
  overdueSeeds,
  overdueTensionBump,
  recordSeedMention,
  sweepSeedCandidates,
} from "@/lib/direction/seeds";
import { rollingCheckpoint } from "@/lib/direction/session";
import { CLASSIFY, STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment, callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { runSakkanSample, sakkanDue } from "@/lib/sakkan/sakkan";
import { CATEGORY_DECAY } from "@/lib/turn/retrieval";
import { ArcOverride } from "@/lib/types/arc";
import { DIRECTOR_MAX_INTERVAL } from "@/lib/types/direction";
import { CommitScene } from "@/lib/types/sidecar";
import { and, asc, eq, inArray, lte, max, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Chronicler Group 2 — the may-lag write group (blueprint §5.8). Detached
 * after the done event; each step is idempotent, individually checkpointed in
 * `turns.checkpoints.g2` (a jsonb map of step booleans), and guaranteed to
 * catch up before its own reader runs — `settleG2IfPending` settles any turn
 * whose G2 is incomplete at the top of the next submit, since the next turn's
 * Phase A reads the semantic layer this group writes (§5.8).
 *
 * The distiller result is stashed into `checkpoints.g2_payload` so crash
 * catch-up replays every downstream step from it WITHOUT a second model call.
 */

const G2_PROVENANCE = "chronicler_g2";
const PROMOTION_PROVENANCE = "chronicler_promotion";

/**
 * In-process guard: one settle per turn at a time (single-replica, §5.7).
 * A Map of PROMISES, not a Set — the catch-up path must be able to AWAIT a
 * settle the detached path already started. Skipping it would let the next
 * turn's Phase A read a half-written semantic layer, which is exactly what
 * §5.8's catch-up-before-reader guarantee forbids (caught by the C6 live
 * 3-turn run: turn 3's G2 showed 0 steps because IfPending skipped the
 * in-flight settle and reported "done").
 */
const settling = new Map<string, Promise<void>>();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// --- The distiller contract -------------------------------------------------

// The 15 heat categories are the single source of truth (retrieval.ts); the
// distiller must land facts in one of them so the query-time decay curve
// applies. Derived here so a new category can never drift the two apart.
const CATEGORY_KEYS = Object.keys(CATEGORY_DECAY) as [string, ...string[]];

const DistillFact = z.object({
  content: z.string().min(1),
  category: z.enum(CATEGORY_KEYS),
  entity_name: z.string().optional(),
  is_plot_critical: z.boolean(),
  critical_reason: z.string().optional(),
});

const DistillEntityUpdate = z.object({
  name: z.string().min(1),
  note: z.string().min(1),
  relationship_shift: z.string().optional(),
  faction_ripple: z.string().optional(),
});

/**
 * NO LENGTH BOUNDS (M3, after the 2026-08-01 live diagnosis): the structured-
 * output grammar strips `minItems`/`maxItems`, so a `.max(8)` here could not
 * stop a ninth fact — only fail the parse and lose the whole G2 artifact
 * (fragment, semantic layer, promotions, seeds, marks) over one surplus row.
 * The prompt states the ceilings (DISTILL_SYSTEM) and `clampDistill` applies
 * them before the payload is stashed, so crash-replay sees the same shape.
 */
const DISTILL_FACTS_MAX = 8;
const DISTILL_ENTITY_UPDATES_MAX = 4;

export const DistillOutput = z.object({
  /** One subtext-first sentence: what the scene MEANT, not what happened. */
  narrated_fragment: z.string(),
  /** ≤8; clamped engine-side. */
  facts: z.array(DistillFact).default([]),
  /** ≤4, and only for entities already in the catalog — background never creates (§6.5). */
  entity_updates: z.array(DistillEntityUpdate).default([]),
  /** Seeds the distiller read the scene as engaging. A DECLARED-path source
   *  (like the sidecar's intended mentions), never a confirmation: the
   *  distiller is never shown the ledger, so §7.6's probe is what confirms. */
  confirmed_seed_descriptions: z.array(z.string()).default([]),
  /** Out-of-fiction player craft feedback ("less flowery please") — usually empty. */
  meta_comments: z.array(z.string()).default([]),
});
type DistillOutput = z.infer<typeof DistillOutput>;

function clampDistill(payload: DistillOutput, ctx: { campaignId: string; turnNumber: number }) {
  const cap = <T>(list: T[], max: number, field: string): T[] => {
    if (list.length <= max) return list;
    console.warn(`[g2] ${field} over its ${max}-item ceiling — clamped, distill kept`, {
      ...ctx,
      emitted: list.length,
    });
    return list.slice(0, max);
  };
  return {
    ...payload,
    facts: cap(payload.facts, DISTILL_FACTS_MAX, "facts"),
    entity_updates: cap(payload.entity_updates, DISTILL_ENTITY_UPDATES_MAX, "entity_updates"),
  };
}

const DISTILL_SYSTEM = [
  "You are the Chronicler's distiller. Read the player's input and the scene",
  "the writer produced, and extract what the flywheel must remember. Return:",
  "narrated_fragment — ONE subtext-first sentence naming what the scene MEANT",
  "(the motive, shift, or cost underneath), not a recap of events. facts — up",
  "to 8 durable facts, each in ONE of the given categories; mark is_plot_critical",
  "true only when losing the fact breaks continuity (a death, an alliance, a",
  "revealed secret) and give a critical_reason — facts past the eighth are",
  "discarded unread, so rank them. entity_updates — up to 4 (likewise), ONLY",
  "for characters/factions already established in the scene, with a note and any",
  "relationship_shift / faction_ripple. confirmed_seed_descriptions — the seeds",
  "the scene genuinely engaged. meta_comments — out-of-fiction craft feedback",
  "the player voiced (usually none). Do not invent; distill what is on the page.",
].join(" ");

export const ArcTransitionCheck = z.object({
  transitioned: z.boolean(),
  evidence: z.string().optional(),
});

/**
 * The §7.6 declared-detection probe. Indexes, not descriptions: an index is
 * unambiguous and cheap, and the grammar strips bounds anyway — an
 * out-of-range number is filtered at the call site rather than failing the
 * parse and costing every real confirmation in the same emit.
 */
export const SeedMentionCheck = z.object({ surfaced: z.array(z.number().int()).default([]) });

// --- Checkpoint plumbing ----------------------------------------------------

type G2Markers = Record<string, boolean>;

interface Checkpoints {
  g2?: G2Markers;
  g2_payload?: unknown;
  /** Per-step failure counter (M3R2 C5) — the bound on honest retries. */
  g2_attempts?: Record<string, number>;
  /** Steps given up on after G2_MAX_STEP_ATTEMPTS, with the last reason. */
  g2_abandoned?: Record<string, string>;
  [key: string]: unknown;
}

function checkpointSql(g2: G2Markers, patch: Record<string, unknown> = {}) {
  return sql`${turns.checkpoints} || ${JSON.stringify({ g2, ...patch })}::jsonb`;
}

/**
 * How many settles a failing step may cost before G2 gives up on it (M3R2 C5).
 *
 * "Never mark a failed step done" and "never retry forever" are both real: a
 * step that fails permanently (a poisoned row, a schema the model cannot
 * satisfy) would otherwise re-run — and re-BILL, the distiller is a judgment
 * call — at the top of every submit for the life of the campaign, and the
 * turn would never reach its terminal marker, so `settleG2IfPending` would
 * re-scan it forever. Three attempts, then the step is recorded as abandoned
 * with its reason and stops running. Abandoned is a LOUD state: it rides the
 * checkpoint row where the audit found it, not a console line.
 */
export const G2_MAX_STEP_ATTEMPTS = 3;

/** The steps whose completion the terminal marker waits on (order = run order). */
const G2_STEPS = [
  "distill",
  "fragment",
  "semantic",
  "promotion",
  "entities",
  "seeds",
  "seed_sweep",
  "arc_watcher",
  "marks",
  "heat_batch",
  "compaction",
  "director_trigger",
  "rolling_checkpoint",
  "sakkan",
] as const;

/** A step name, plus `media` — the terminal marker, which no step waits on. */
type G2Step = (typeof G2_STEPS)[number] | "media";

// ---------------------------------------------------------------------------

export async function settleG2(db: Db, turnId: string): Promise<void> {
  const inFlight = settling.get(turnId);
  if (inFlight) return inFlight;
  const run = settleG2Inner(db, turnId).finally(() => {
    settling.delete(turnId);
  });
  settling.set(turnId, run);
  return run;
}

/**
 * Catch-up (§5.8): settle every complete-status turn whose G2 has not reached
 * its last marker, oldest first — run at the top of the next submit so the
 * next Phase A never reads a half-written semantic layer.
 *
 * NEVER throws (M3R2 C5). This runs inside `submitTurn`, so before the step
 * isolation below a single failing G2 step — an embedding timeout, one bad
 * jsonb row — propagated out of here and 500'd the player's NEXT SUBMIT, and
 * every retry after it, until someone fixed the data by hand. A lagging
 * background write group must never take the player's turn with it: the
 * failure is logged, the remaining turns still settle, and the unfinished
 * steps retry on the next pass (bounded by G2_MAX_STEP_ATTEMPTS).
 */
export async function settleG2IfPending(db: Db, campaignId: string): Promise<void> {
  const rows = await db
    .select({ id: turns.id, checkpoints: turns.checkpoints })
    .from(turns)
    .where(and(eq(turns.campaignId, campaignId), eq(turns.status, "complete")))
    .orderBy(asc(turns.turnNumber));
  for (const r of rows) {
    const g2 = (r.checkpoints as Checkpoints | null)?.g2;
    if (!g2?.media) {
      try {
        await settleG2(db, r.id);
      } catch (err) {
        console.error("[g2] settle failed for a pending turn — drain continues", {
          campaignId,
          turnId: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

async function settleG2Inner(db: Db, turnId: string): Promise<void> {
  const [turn] = await db.select().from(turns).where(eq(turns.id, turnId));
  if (!turn || turn.status !== "complete") return;
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, turn.campaignId));
  if (!campaign) return;

  const campaignId = turn.campaignId;
  const turnNumber = turn.turnNumber;
  const narration = turn.narration ?? "";
  const parsedSelection = TierSelection.safeParse(campaign.tierModels);
  const selection = parsedSelection.success ? parsedSelection.data : DEV_TIER_SELECTION;
  const parsedSidecar = CommitScene.safeParse(turn.sidecar);
  const sidecar = parsedSidecar.success ? parsedSidecar.data : null;

  const checkpoints = (turn.checkpoints ?? {}) as Checkpoints;
  const g2: G2Markers = { ...(checkpoints.g2 ?? {}) };
  const attempts: Record<string, number> = { ...(checkpoints.g2_attempts ?? {}) };
  const abandoned: Record<string, string> = { ...(checkpoints.g2_abandoned ?? {}) };
  /**
   * The failure-ledger write: the marker map EXACTLY as it stands, plus the
   * attempts/abandoned patch. Only `step`'s catch and the abandon paths use
   * it, and they rely on the map being unpoisoned — see the marker rule below.
   */
  const markDb = (patch: Record<string, unknown> = {}) =>
    db
      .update(turns)
      .set({ checkpoints: checkpointSql(g2, patch) })
      .where(eq(turns.id, turnId));

  /**
   * THE MARKER RULE (M3R3 close). A step's marker must land in the SAME
   * transaction as its writes — a marker that could commit without them (or
   * vice versa) means replay either double-applies the work or loses it. But
   * the SHARED `g2` map may only learn about the marker once that transaction
   * has actually COMMITTED, because `step`'s catch serializes this very map:
   * a step that set `g2[name] = true` before its closing `tx.update` and then
   * failed at the update (or at COMMIT) was persisted as DONE with its writes
   * rolled back, and nothing would ever retry it — the same opposite lie the
   * per-step isolation was written to remove.
   *
   * So: the persisted marker is always a COPY, and the shared map is mutated
   * only after the await returns.
   */
  const marked = (name: G2Step): G2Markers => ({ ...g2, [name]: true });
  /** Completion write for a step that owns no transaction. */
  const markStep = async (name: G2Step, patch: Record<string, unknown> = {}) => {
    await db
      .update(turns)
      .set({ checkpoints: checkpointSql(marked(name), patch) })
      .where(eq(turns.id, turnId));
    g2[name] = true;
  };
  /** The same write, inside a step's transaction — atomic with its writes.
   *  The caller sets `g2[name]` after `db.transaction(...)` resolves. */
  const txMarkStep = (tx: Tx, name: G2Step, patch: Record<string, unknown> = {}) =>
    tx
      .update(turns)
      .set({ checkpoints: checkpointSql(marked(name), patch) })
      .where(eq(turns.id, turnId));

  /**
   * Per-step failure isolation (M3R2 C5). Before this, eleven of the fifteen
   * steps ran bare inside one function: the FIRST failure threw out of the
   * settle, so every later step was skipped (a failed embedding cost the
   * turn its promotions, its seed sweep, its heat batch AND its Director
   * cycle) and — because `settleG2IfPending` is awaited inside submitTurn —
   * it wedged the player's next turn. The other four caught their own errors
   * and then marked themselves DONE anyway, which is the opposite lie: the
   * work never happened and nothing would ever retry it.
   *
   * Now: a step runs when its dependencies are marked, marks itself inside
   * its own transaction (the marker rule above), and on failure marks
   * NOTHING — the attempt is counted, the reason is recorded on the row, and
   * the next settle tries again until G2_MAX_STEP_ATTEMPTS.
   */
  const step = async (
    name: (typeof G2_STEPS)[number],
    fn: () => Promise<void>,
    opts: { requires?: (typeof G2_STEPS)[number][] } = {},
  ): Promise<void> => {
    if (g2[name] || abandoned[name]) return;
    // Abandoned counts as "not available" even when the marker says done: the
    // corrupt-stash path below marks distill complete (it WAS paid for) while
    // its result is unusable, and a dependent must read that as dead, not as
    // satisfied.
    const blocked = (opts.requires ?? []).find((d) => !g2[d] || abandoned[d]);
    if (blocked) {
      // Ordering is a correctness property here, not tidiness: promotion reads
      // the rows `semantic` writes, so running it against a failed semantic
      // step would mark a promotion that promoted nothing.
      if (abandoned[blocked]) {
        // Its dependency is never coming. Abandon transitively rather than
        // defer forever — a step waiting on a dead one would hold the terminal
        // marker open and make the drain re-scan this turn at every submit.
        abandoned[name] = `blocked: ${blocked} abandoned`;
        console.error(`[g2] step ${name} abandoned — its dependency ${blocked} was given up on`, {
          campaignId,
          turnNumber,
        });
        await markDb({ g2_attempts: attempts, g2_abandoned: abandoned }).catch(() => {});
        return;
      }
      console.warn(`[g2] step ${name} waits on ${blocked} — deferred to the next settle`, {
        campaignId,
        turnNumber,
      });
      return;
    }
    try {
      await fn();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const n = (attempts[name] ?? 0) + 1;
      attempts[name] = n;
      if (n >= G2_MAX_STEP_ATTEMPTS) abandoned[name] = reason.slice(0, 200);
      console.error(
        `[g2] step ${name} FAILED (attempt ${n}/${G2_MAX_STEP_ATTEMPTS})${
          abandoned[name] ? " — abandoned" : " — retries next settle"
        }`,
        { campaignId, turnNumber, error: reason },
      );
      // The marker map is written UNCHANGED; only the failure ledger moves.
      // That is only true because a step's marker reaches this map after its
      // transaction commits, never before it (the marker rule above) — the
      // rolled-back step is absent here, so it retries.
      await markDb({ g2_attempts: attempts, g2_abandoned: abandoned }).catch(() => {});
    }
  };

  // 1. distill — the ONE bundled judgment call; result stashed for replay.
  let payload: DistillOutput | undefined;
  if (g2.distill) {
    // A corrupt stash is not recoverable without re-billing the distiller, and
    // the marker says it was already paid for — so it is recorded as an
    // abandoned step (which abandons its dependents transitively) instead of
    // throwing out of the settle on every submit forever.
    const stashed = DistillOutput.safeParse(checkpoints.g2_payload);
    if (stashed.success) {
      payload = stashed.data;
    } else {
      abandoned.distill = `stashed payload unparseable: ${stashed.error.message.slice(0, 160)}`;
      console.error("[g2] the stashed distill payload is corrupt — downstream steps abandoned", {
        campaignId,
        turnNumber,
      });
      await markDb({ g2_attempts: attempts, g2_abandoned: abandoned }).catch(() => {});
    }
  } else {
    await step("distill", async () => {
      const emitted = await callJudgment(selection, {
        name: "g2_distill",
        schema: DistillOutput,
        campaignId,
        turnNumber,
        effort: "high",
        maxTokens: STRUCTURED_RICH,
        system: DISTILL_SYSTEM,
        prompt: `PLAYER INPUT:\n${turn.playerInput}\n\nNARRATION:\n${narration}`,
      });
      // Clamp BEFORE the stash so crash-replay reads the same shape (the ceilings
      // are no longer schema-enforceable — see the contract note above).
      payload = clampDistill(emitted, { campaignId, turnNumber });
      await markStep("distill", { g2_payload: payload });
    });
  }
  // Every payload consumer below declares `distill` as its dependency, so an
  // abandoned distill leaves them deferred rather than running on nothing —
  // this local is the type-level half of the same fact.
  const distilled = payload;

  // 2. fragment — the subtext-first sentence onto the episodic row.
  await step(
    "fragment",
    async () => {
      if (!distilled) return;
      await db
        .update(episodicRecords)
        .set({ narratedFragment: distilled.narrated_fragment })
        .where(
          and(
            eq(episodicRecords.campaignId, campaignId),
            eq(episodicRecords.turnNumber, turnNumber),
            notTombstoned(episodicRecords),
          ),
        );
      await markStep("fragment");
    },
    { requires: ["distill"] },
  );

  // 3. semantic — embed facts (batch) → semantic layer with the heat envelope.
  await step(
    "semantic",
    async () => {
      if (!distilled) return;
      const facts = distilled.facts;
      const embeddings =
        facts.length > 0
          ? await embedTexts(
              facts.map((f) => f.content),
              { inputType: "document", patience: "interactive", campaignId, turnNumber },
            )
          : [];
      await db.transaction(async (tx) => {
        const rows: (typeof semanticMemories.$inferInsert)[] = [];
        for (const [i, f] of facts.entries()) {
          const embedding = embeddings[i];
          if (!embedding) continue;
          // v3: a plot-critical relationship fact keeps a heat floor of 40 so
          // the bond never decays out of reach; everything else floors at 1.
          const relCritical = f.category === "relationship" && f.is_plot_critical;
          rows.push({
            campaignId,
            content: f.content,
            embedding,
            category: f.category,
            baseHeat: 100,
            heatFloor: relCritical ? 40 : 1,
            lastBoostedTurn: turnNumber,
            plotCritical: f.is_plot_critical,
            turnId: turnNumber,
            provenance: G2_PROVENANCE,
            confidence: 0.8,
          });
        }
        if (rows.length > 0) await tx.insert(semanticMemories).values(rows);
        await txMarkStep(tx, "semantic");
      });
      // Committed — only now may the shared map say so (the marker rule).
      g2.semantic = true;
    },
    { requires: ["distill"] },
  );

  // 4. promotion (§6.3) — plot-critical facts ALSO enter the Critical layer.
  //    (Demotion of stale criticals is the Director's dailies job, C7.)
  await step(
    "promotion",
    async () => {
      await db.transaction(async (tx) => {
        const promotable = await tx
          .select({ id: semanticMemories.id, content: semanticMemories.content })
          .from(semanticMemories)
          .where(
            and(
              eq(semanticMemories.campaignId, campaignId),
              eq(semanticMemories.turnId, turnNumber),
              eq(semanticMemories.plotCritical, true),
              notTombstoned(semanticMemories),
            ),
          );
        if (promotable.length > 0) {
          await tx.insert(criticalFacts).values(
            promotable.map((m) => ({
              campaignId,
              content: m.content,
              category: "promoted",
              sourceMemoryId: m.id,
              turnId: turnNumber,
              provenance: PROMOTION_PROVENANCE,
              confidence: 0.9,
            })),
          );
        }
        await txMarkStep(tx, "promotion");
      });
      g2.promotion = true;
    },
    // The promotable set IS what step 3 just wrote (§6.3).
    { requires: ["semantic"] },
  );

  // 5. entities — background enrichment (never creates, §6.5) + spotlight debt.
  await step(
    "entities",
    async () => {
      if (!distilled) return;
      await db.transaction(async (tx) => {
        const active = await tx
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.campaignId, campaignId),
              eq(entities.status, "active"),
              notTombstoned(entities),
            ),
          );
        for (const e of active) {
          const state = { ...((e.state ?? {}) as Record<string, unknown>) };
          let block = e.block;
          let dirty = false;

          const update = distilled.entity_updates.find(
            (u) => u.name.toLowerCase() === e.name.toLowerCase(),
          );
          if (update) {
            if (!block.includes(update.note)) {
              block = block ? `${block}\n${update.note}` : update.note;
            }
            if (update.relationship_shift) {
              const rel = { ...((state.relationships as Record<string, unknown>) ?? {}) };
              rel[String(turnNumber)] = update.relationship_shift;
              state.relationships = rel;
            }
            if (update.faction_ripple) {
              const fac = { ...((state.factionReputation as Record<string, unknown>) ?? {}) };
              fac[String(turnNumber)] = update.faction_ripple;
              state.factionReputation = fac;
            }
            state.interiorityEvents = ((state.interiorityEvents as number) ?? 0) + 1;
            dirty = true;

            await tx.insert(entityVersions).values({
              entityId: e.id,
              version: await nextVersion(tx, e.id),
              block,
              turnId: turnNumber,
              provenance: G2_PROVENANCE,
              confidence: 0.8,
            });
          }

          // Spotlight debt: present this scene → 0; absent → +1 (npc/faction only).
          // Word-boundary match, never substring — "Rei" inside "reign" is not
          // a scene appearance (C6 audit: short names corrupted the debt). The
          // boundaries are Unicode lookarounds, not \b: \b is ASCII-only, so a
          // name ending in a macron/accent ("Ryū") would never test present
          // and accrue phantom debt every scene it appears in (C6 re-audit).
          if (e.entityType === "npc" || e.entityType === "faction") {
            const escaped = e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const namePattern = new RegExp(
              `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
              "iu",
            );
            const present = Boolean(update) || namePattern.test(narration);
            state.spotlightDebt = present ? 0 : ((state.spotlightDebt as number) ?? 0) + 1;
            dirty = true;
          }

          if (dirty) {
            await tx.update(entities).set({ block, state }).where(eq(entities.id, e.id));
          }
        }
        await txMarkStep(tx, "entities");
      });
      g2.entities = true;
    },
    { requires: ["distill"] },
  );

  // 6. seeds, DECLARED path (§7.6): the writer's own claim about this scene —
  //    the sidecar's intended mentions plus any the distiller named — put to
  //    ONE cheap bounded probe that reads the page and says which of them
  //    actually surfaced. Confirmed mentions bump the counter and the urgency;
  //    an intention the prose never kept changes nothing. Before M3 C2 every
  //    declared mention bumped the ledger unread, and the distiller was asked
  //    to "confirm" seeds it was never shown.
  //    Read by the organic sweep below (6b) as its exclusion list.
  // Crash-replay honesty (stack audit NIT 6): a crash between step 6 and 6b
  // replays with g2.seeds already true — the exclusion list must come back
  // from the checkpoint, or the just-confirmed seed gains a same-turn
  // candidate the next batch counts twice.
  let declaredMentionIds: string[] = Array.isArray(checkpoints.seed_declared)
    ? (checkpoints.seed_declared as string[])
    : [];
  await step(
    "seeds",
    async () => {
      if (!distilled) return;
      const declared = [
        ...new Set(
          [...(sidecar?.intended_seed_mentions ?? []), ...distilled.confirmed_seed_descriptions]
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const named = new Map<string, { id: string; description: string }>();
      for (const m of declared) {
        // Literal containment: %/_ inside the model's string are live ILIKE
        // wildcards unless escaped — unescaped, one stray "50%" matches seeds
        // nobody named (the same hazard the C7 audit found in demote_criticals).
        const literal = m.replace(/([\\%_])/g, "\\$1");
        const matched = await db
          .select({ id: seeds.id, description: seeds.description })
          .from(seeds)
          .where(
            and(
              eq(seeds.campaignId, campaignId),
              inArray(seeds.status, ["planted", "confirmed"]),
              notTombstoned(seeds),
              sql`(${seeds.id}::text = ${m} OR ${seeds.description} ILIKE ${`%${literal}%`})`,
            ),
          );
        for (const s of matched) named.set(s.id, s);
      }

      // Cost discipline (§7.6): nothing declared, or nothing declared that maps
      // onto a live seed → no probe at all.
      const roster = [...named.values()];
      let surfaced: { id: string }[] = [];
      if (roster.length > 0) {
        const check = await callProbe(selection, {
          name: "seed_mention_check",
          schema: SeedMentionCheck,
          campaignId,
          turnNumber,
          system: [
            "A SEED is a planted narrative promise a story owes an answer to. The writer",
            "claimed this scene would touch the seeds below. Read the scene and say which",
            "of them ACTUALLY SURFACED ON THE PAGE — named, alluded to, or acted upon so a",
            "reader would feel the thread. Sharing a setting, a character, or a mood with a",
            "seed is not surfacing it. Return only the numbers that surfaced; return none",
            "if the scene kept no promise.",
          ].join(" "),
          prompt: [
            "SEEDS:",
            ...roster.map((s, i) => `${i}. ${s.description}`),
            "",
            "SCENE:",
            narration,
          ].join("\n"),
          maxTokens: CLASSIFY,
        });
        // The grammar strips bounds, so an out-of-range index is a live outcome:
        // filter, never fail (a bad number must not cost the real confirmations).
        surfaced = [...new Set(check.surfaced)]
          .map((i) => roster[i])
          .filter((s): s is { id: string; description: string } => Boolean(s));
      }

      declaredMentionIds = surfaced.map((s) => s.id);
      await db.transaction(async (tx) => {
        for (const s of surfaced) await recordSeedMention(tx, s.id);
        await txMarkStep(tx, "seeds", { seed_declared: declaredMentionIds });
      });
      g2.seeds = true;
    },
    { requires: ["distill"] },
  );

  // 6b. seeds, ORGANIC path (§7.6): the sweep the prose never declared. Pure
  //     code — one embedding of this scene cosined against every open seed's
  //     description. Hits accumulate as CANDIDATES on the seed row; only the
  //     batched adjudication on Director cadence may call one a mention.
  //     Seeds the declared probe just confirmed sit this turn out so the two
  //     paths cannot bill the same scene twice. (A crash landing exactly
  //     BETWEEN step 6 and this one replays with an empty exclusion list — the
  //     cost is one extra candidate on a seed the page genuinely surfaced,
  //     which the adjudicator still judges on the evidence.)
  // The catch that swallowed this failure AND marked it done is gone (C5): a
  // failed sweep is candidates the ledger never saw, and the sweep dedups by
  // turn (seeds.ts), so re-running it on the next settle is free of doubles.
  await step(
    "seed_sweep",
    async () => {
      await sweepSeedCandidates(db, campaignId, turnNumber, narration, {
        alreadyMentioned: declaredMentionIds,
      });
      await markStep("seed_sweep");
    },
    { requires: ["seeds"] },
  );

  // 7. arc_watcher (§4.2) — if an override is active, one probe asks whether
  //    the scene crossed its transition signal; on yes, clear it + leave a mark.
  await step("arc_watcher", async () => {
    const parsedOverride = ArcOverride.safeParse(campaign.arcOverride);
    if (parsedOverride.success) {
      const override = parsedOverride.data;
      const check = await callProbe(selection, {
        name: "arc_transition_check",
        schema: ArcTransitionCheck,
        campaignId,
        turnNumber,
        system:
          "An arc override holds a temporary tonal/framing shift until a specific in-fiction event occurs. Judge whether THIS scene satisfies the transition signal. Answer transitioned=true only on a clear crossing.",
        prompt: `TRANSITION SIGNAL: ${override.transition_signal}\n\nSCENE:\n${narration}`,
        maxTokens: CLASSIFY,
      });
      await db.transaction(async (tx) => {
        if (check.transitioned) {
          await tx.update(campaigns).set({ arcOverride: null }).where(eq(campaigns.id, campaignId));
          await tx.insert(pencilMarks).values({
            campaignId,
            kind: "craft_note",
            topic: "arc_override_transition",
            direction: `override '${override.arc_name}' completed: ${override.transition_signal}`,
            evidence: check.evidence ?? "arc transition probe confirmed the signal",
            turnId: turnNumber,
            provenance: G2_PROVENANCE,
            confidence: 0.85,
          });
        }
        await txMarkStep(tx, "arc_watcher");
      });
      g2.arc_watcher = true;
    } else {
      await markStep("arc_watcher");
    }
  });

  // 8. marks — player meta-comments become craft-note pencil marks (§6.6).
  await step(
    "marks",
    async () => {
      if (!distilled) return;
      await db.transaction(async (tx) => {
        if (distilled.meta_comments.length > 0) {
          await tx.insert(pencilMarks).values(
            distilled.meta_comments.map((comment) => ({
              campaignId,
              kind: "craft_note",
              topic: "player_meta",
              direction: comment,
              evidence: "probe-detected player meta-comment",
              turnId: turnNumber,
              provenance: G2_PROVENANCE,
              confidence: 0.85,
            })),
          );
        }
        await txMarkStep(tx, "marks");
      });
      g2.marks = true;
    },
    { requires: ["distill"] },
  );

  // 9. heat_batch — CLOSE THE C4 SEAM. Fold accumulated access boosts into
  //    base heat as one batched UPDATE per memory, then delete the boosts.
  await step("heat_batch", async () => {
    await db.transaction(async (tx) => {
      const boosts = await tx
        .select()
        .from(heatBoosts)
        .where(and(eq(heatBoosts.campaignId, campaignId), lte(heatBoosts.turnNumber, turnNumber)));
      if (boosts.length > 0) {
        const agg = new Map<string, { total: number; maxTurn: number }>();
        for (const b of boosts) {
          const prev = agg.get(b.memoryId) ?? { total: 0, maxTurn: 0 };
          agg.set(b.memoryId, {
            total: prev.total + b.boost,
            maxTurn: Math.max(prev.maxTurn, b.turnNumber),
          });
        }
        for (const [memoryId, { total, maxTurn }] of agg) {
          await tx
            .update(semanticMemories)
            .set({
              baseHeat: sql`LEAST(100, ${semanticMemories.baseHeat} + ${total})`,
              lastBoostedTurn: sql`GREATEST(${semanticMemories.lastBoostedTurn}, ${maxTurn})`,
              lastBoostedAt: new Date(),
            })
            .where(eq(semanticMemories.id, memoryId));
        }
        await tx
          .delete(heatBoosts)
          .where(
            and(eq(heatBoosts.campaignId, campaignId), lte(heatBoosts.turnNumber, turnNumber)),
          );
      }
      await txMarkStep(tx, "heat_batch");
    });
    g2.heat_batch = true;
  });

  // 10. compaction — run the real (subtext-first) compactor when due (§6.2).
  //     Idempotent per watermark, so it lives outside the marker transaction.
  await step("compaction", async () => {
    await maybeCompact(db, campaignId, turnNumber, selection);
    await markStep("compaction");
  });

  // 11. director_trigger — the §7.1 hybrid trigger, bound (C7). Fold this
  //     turn into the accumulators (Layout stashed epicness + any pacer
  //     phase-transition suggestion in the checkpoints), bump tension for
  //     overdue seeds (v3), evaluate, and run the cycle when it fires. The
  //     accumulator save + marker land BEFORE the cycle: a failed Director
  //     run is a skipped daily (the next trigger fires within 8 turns), never
  //     a wedged G2 — and a replayed cycle would double-apply seed plants.
  await step(
    "director_trigger",
    async () => {
      if (!distilled) return;
      const stash = checkpoints as { epicness?: number; pacer_transition?: string | null };
      const conteForEvents = turn.conte as {
        outcome?: { narrative_weight?: string };
        mechanics?: { combat_results?: string };
      } | null;
      const events: string[] = [];
      if (turn.tier === "sakuga") events.push("sakuga_moment");
      if (conteForEvents?.outcome?.narrative_weight === "CLIMACTIC") {
        events.push(conteForEvents.mechanics?.combat_results ? "boss_defeat" : "climactic_beat");
      }
      if (
        (sidecar?.intended_seed_mentions?.length ?? 0) > 0 ||
        distilled.confirmed_seed_descriptions.length > 0
      ) {
        events.push("foreshadowing_mentioned");
      }
      if (stash.pacer_transition) {
        events.push(`phase_transition_suggested:${stash.pacer_transition}`);
      }

      let direction = accumulate(await loadDirectionState(db, campaignId), {
        epicness: stash.epicness ?? 0,
        events,
      });
      const overdue = await overdueSeeds(db, campaignId, turnNumber);
      if (overdue.length > 0) {
        direction = {
          ...direction,
          tension_level: Math.min(1, direction.tension_level + overdueTensionBump(overdue.length)),
        };
      }
      const trigger = evaluateDirectorTrigger(direction, turnNumber);
      await saveDirectionState(db, campaignId, direction);
      await markStep("director_trigger");
      // The marker stays BEFORE the cycle deliberately (unchanged, C7): a
      // replayed cycle would double-apply seed plants, so the daily is skipped
      // rather than retried — the trigger re-arms within DIRECTOR_MAX_INTERVAL
      // turns and M3R2 C1's attempt stamp backs the refire off. What changes
      // here is only that the failure stops being a console line: it rides
      // pending_flags, the channel the next dossier already reads, exactly as
      // C1 made the session-open review failure durable. The append is
      // surgical — a failed cycle may have half-written state, and a wholesale
      // save would race it.
      if (trigger.fire) {
        try {
          await runDirectorCycle(db, campaignId, turnNumber, {
            trigger: trigger.reasons.join(","),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[g2] director cycle failed (turn ${turnNumber}) — skipped daily, next trigger ≤${DIRECTOR_MAX_INTERVAL} turns:`,
            err,
          );
          const flag = `Your turn-${turnNumber} cycle FAILED (${msg.slice(0, 140)}) — that daily never ran; its arc, seed and spotlight decisions are still owed.`;
          await db
            .update(campaigns)
            .set({
              directionState: sql`jsonb_set(coalesce(${campaigns.directionState}, '{}'::jsonb), '{pending_flags}', coalesce(${campaigns.directionState}->'pending_flags', '[]'::jsonb) || ${JSON.stringify([flag])}::jsonb)`,
            })
            .where(eq(campaigns.id, campaignId))
            .catch(() => {});
        }
      }
    },
    { requires: ["distill"] },
  );

  // 11b. rolling checkpoint (§9.4 close trigger 3): every 12 turns the open
  //      session's memo refreshes in place, so a never-closed session still
  //      accrues Learned-layer content. Off-cadence it is a no-op, and the
  //      memo write is idempotent — so a failure now retries instead of
  //      marking a checkpoint that never happened (C5).
  await step("rolling_checkpoint", async () => {
    await rollingCheckpoint(db, campaignId, turnNumber);
    await markStep("rolling_checkpoint");
  });

  // 11c. sakkan (§4.5, C8): drift sampled on cadence — every 8 turns or a
  //      sakuga scene (session close hooks separately). Trust rule: advisory
  //      only; a failed sample is a skipped measurement — but the SKIP is now
  //      retried rather than recorded as a sample that never ran (C5); the
  //      cadence guard (last_sample_turn) keeps the retry from double-sampling.
  await step("sakkan", async () => {
    const direction = await loadDirectionState(db, campaignId);
    if (sakkanDue(direction, turnNumber, { sakuga: turn.tier === "sakuga" })) {
      await runSakkanSample(db, campaignId, turnNumber, {
        trigger: turn.tier === "sakuga" ? "sakuga" : "interval",
      });
    }
    await markStep("sakkan");
  });

  // 12. media — the §9.5 disabled seam, and the TERMINAL marker: it is the
  //     flag settleG2IfPending reads to decide a turn is settled, so it may
  //     only land once every other step has finished or been abandoned.
  //     Marking it while a step still owes work would tell the catch-up that
  //     a half-written turn is done — the §5.8 guarantee inverted.
  const unfinished = G2_STEPS.filter((s) => !g2[s] && !abandoned[s]);
  if (!g2.media) {
    if (unfinished.length > 0) {
      console.warn("[g2] settle incomplete — terminal marker withheld", {
        campaignId,
        turnNumber,
        unfinished,
      });
    } else {
      dispatchMediaTriggers();
      const abandonedSteps = G2_STEPS.filter((s) => abandoned[s]);
      if (abandonedSteps.length > 0) {
        console.error("[g2] turn settled with ABANDONED steps — this work never ran", {
          campaignId,
          turnNumber,
          abandoned: abandonedSteps,
        });
      }
      await markStep("media");
    }
  }
}

async function nextVersion(tx: Tx, entityId: string): Promise<number> {
  const [row] = await tx
    .select({ v: max(entityVersions.version) })
    .from(entityVersions)
    .where(eq(entityVersions.entityId, entityId));
  return (row?.v ?? 0) + 1;
}

/**
 * The §9.5 disabled media seam. Media generation is approved but deliberately
 * late (M5): portraits + location art + cutscenes + a per-season key visual,
 * every clip reference-conditioned on the settei behind an on-model eval gate.
 * The reference pipeline — portraits/model sheets as identity anchors, the
 * World component's `visual_style` as style conditioning — is scaffolded from
 * M1 and DISABLED, per the §9.5 timing discipline: "we build knowing it's
 * coming, but don't concern ourselves with media until we can play a real,
 * enduring session and love it enough to want to see it." Media is the second
 * named multi-provider exception (with embeddings); it is fire-and-forget,
 * never blocks the turn, and non-reversible under rewind (flagged) when it
 * lands. Until M5 this dispatch point stays a no-op — wire NOTHING here.
 */
export function dispatchMediaTriggers(): void {
  // Intentionally empty (§9.5). No media work before M5.
}
