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
import { overdueSeeds, overdueTensionBump } from "@/lib/direction/seeds";
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
import { and, asc, eq, lte, max, sql } from "drizzle-orm";
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

const DistillOutput = z.object({
  /** One subtext-first sentence: what the scene MEANT, not what happened. */
  narrated_fragment: z.string(),
  facts: z.array(DistillFact).max(8).default([]),
  /** Only for entities already in the catalog — background never creates (§6.5). */
  entity_updates: z.array(DistillEntityUpdate).max(4).default([]),
  /** Which sidecar-mentioned seeds the scene actually paid attention to. */
  confirmed_seed_descriptions: z.array(z.string()).default([]),
  /** Out-of-fiction player craft feedback ("less flowery please") — usually empty. */
  meta_comments: z.array(z.string()).default([]),
});
type DistillOutput = z.infer<typeof DistillOutput>;

const DISTILL_SYSTEM = [
  "You are the Chronicler's distiller. Read the player's input and the scene",
  "the writer produced, and extract what the flywheel must remember. Return:",
  "narrated_fragment — ONE subtext-first sentence naming what the scene MEANT",
  "(the motive, shift, or cost underneath), not a recap of events. facts — up",
  "to 8 durable facts, each in ONE of the given categories; mark is_plot_critical",
  "true only when losing the fact breaks continuity (a death, an alliance, a",
  "revealed secret) and give a critical_reason. entity_updates — up to 4, ONLY",
  "for characters/factions already established in the scene, with a note and any",
  "relationship_shift / faction_ripple. confirmed_seed_descriptions — the seeds",
  "the scene genuinely engaged. meta_comments — out-of-fiction craft feedback",
  "the player voiced (usually none). Do not invent; distill what is on the page.",
].join(" ");

const ArcTransitionCheck = z.object({
  transitioned: z.boolean(),
  evidence: z.string().optional(),
});

// --- Checkpoint plumbing ----------------------------------------------------

type G2Markers = Record<string, boolean>;

interface Checkpoints {
  g2?: G2Markers;
  g2_payload?: unknown;
  [key: string]: unknown;
}

function checkpointSql(g2: G2Markers, patch: Record<string, unknown> = {}) {
  return sql`${turns.checkpoints} || ${JSON.stringify({ g2, ...patch })}::jsonb`;
}

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
      await settleG2(db, r.id);
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
  const markDb = (patch: Record<string, unknown> = {}) =>
    db
      .update(turns)
      .set({ checkpoints: checkpointSql(g2, patch) })
      .where(eq(turns.id, turnId));

  // 1. distill — the ONE bundled judgment call; result stashed for replay.
  let payload: DistillOutput;
  if (!g2.distill) {
    payload = await callJudgment(selection, {
      name: "g2_distill",
      schema: DistillOutput,
      campaignId,
      turnNumber,
      effort: "high",
      maxTokens: STRUCTURED_RICH,
      system: DISTILL_SYSTEM,
      prompt: `PLAYER INPUT:\n${turn.playerInput}\n\nNARRATION:\n${narration}`,
    });
    g2.distill = true;
    await markDb({ g2_payload: payload });
  } else {
    payload = DistillOutput.parse(checkpoints.g2_payload);
  }

  // 2. fragment — the subtext-first sentence onto the episodic row.
  if (!g2.fragment) {
    await db
      .update(episodicRecords)
      .set({ narratedFragment: payload.narrated_fragment })
      .where(
        and(
          eq(episodicRecords.campaignId, campaignId),
          eq(episodicRecords.turnNumber, turnNumber),
          notTombstoned(episodicRecords),
        ),
      );
    g2.fragment = true;
    await markDb();
  }

  // 3. semantic — embed facts (batch) → semantic layer with the heat envelope.
  if (!g2.semantic) {
    const facts = payload.facts;
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
      g2.semantic = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 4. promotion (§6.3) — plot-critical facts ALSO enter the Critical layer.
  //    (Demotion of stale criticals is the Director's dailies job, C7.)
  if (!g2.promotion) {
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
      g2.promotion = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 5. entities — background enrichment (never creates, §6.5) + spotlight debt.
  if (!g2.entities) {
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

        const update = payload.entity_updates.find(
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
          const namePattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
          const present = Boolean(update) || namePattern.test(narration);
          state.spotlightDebt = present ? 0 : ((state.spotlightDebt as number) ?? 0) + 1;
          dirty = true;
        }

        if (dirty) {
          await tx.update(entities).set({ block, state }).where(eq(entities.id, e.id));
        }
      }
      g2.entities = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 6. seeds — declared (sidecar) + confirmed (distiller) mentions bump the
  //    ledger; confirmation flips status. Code only, no model call (§7.6).
  if (!g2.seeds) {
    const mentions = [
      ...new Set(
        [...(sidecar?.intended_seed_mentions ?? []), ...payload.confirmed_seed_descriptions]
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const confirmedSet = new Set(
      payload.confirmed_seed_descriptions.map((s) => s.trim().toLowerCase()),
    );
    await db.transaction(async (tx) => {
      const toUpdate = new Map<string, boolean>(); // seedId -> confirm
      for (const m of mentions) {
        const matched = await tx
          .select({ id: seeds.id })
          .from(seeds)
          .where(
            and(
              eq(seeds.campaignId, campaignId),
              eq(seeds.status, "planted"),
              notTombstoned(seeds),
              sql`(${seeds.id}::text = ${m} OR ${seeds.description} ILIKE ${`%${m}%`})`,
            ),
          );
        for (const s of matched) {
          toUpdate.set(s.id, (toUpdate.get(s.id) ?? false) || confirmedSet.has(m.toLowerCase()));
        }
      }
      for (const [id, confirm] of toUpdate) {
        await tx
          .update(seeds)
          .set({
            mentionCount: sql`${seeds.mentionCount} + 1`,
            urgency: sql`LEAST(1, ${seeds.urgency} + 0.1)`,
            ...(confirm ? { status: "confirmed" } : {}),
          })
          .where(eq(seeds.id, id));
      }
      g2.seeds = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 7. arc_watcher (§4.2) — if an override is active, one probe asks whether
  //    the scene crossed its transition signal; on yes, clear it + leave a mark.
  if (!g2.arc_watcher) {
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
        g2.arc_watcher = true;
        await tx
          .update(turns)
          .set({ checkpoints: checkpointSql(g2) })
          .where(eq(turns.id, turnId));
      });
    } else {
      g2.arc_watcher = true;
      await markDb();
    }
  }

  // 8. marks — player meta-comments become craft-note pencil marks (§6.6).
  if (!g2.marks) {
    await db.transaction(async (tx) => {
      if (payload.meta_comments.length > 0) {
        await tx.insert(pencilMarks).values(
          payload.meta_comments.map((comment) => ({
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
      g2.marks = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 9. heat_batch — CLOSE THE C4 SEAM. Fold accumulated access boosts into
  //    base heat as one batched UPDATE per memory, then delete the boosts.
  if (!g2.heat_batch) {
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
      g2.heat_batch = true;
      await tx
        .update(turns)
        .set({ checkpoints: checkpointSql(g2) })
        .where(eq(turns.id, turnId));
    });
  }

  // 10. compaction — run the real (subtext-first) compactor when due (§6.2).
  //     Idempotent per watermark, so it lives outside the marker transaction.
  if (!g2.compaction) {
    await maybeCompact(db, campaignId, turnNumber, selection);
    g2.compaction = true;
    await markDb();
  }

  // 11. director_trigger — the §7.1 hybrid trigger, bound (C7). Fold this
  //     turn into the accumulators (Layout stashed epicness + any pacer
  //     phase-transition suggestion in the checkpoints), bump tension for
  //     overdue seeds (v3), evaluate, and run the cycle when it fires. The
  //     accumulator save + marker land BEFORE the cycle: a failed Director
  //     run is a skipped daily (the next trigger fires within 8 turns), never
  //     a wedged G2 — and a replayed cycle would double-apply seed plants.
  if (!g2.director_trigger) {
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
      payload.confirmed_seed_descriptions.length > 0
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
    g2.director_trigger = true;
    await markDb();
    if (trigger.fire) {
      try {
        await runDirectorCycle(db, campaignId, turnNumber, {
          trigger: trigger.reasons.join(","),
        });
      } catch (err) {
        console.warn(
          `[g2] director cycle failed (turn ${turnNumber}) — skipped daily, next trigger ≤${DIRECTOR_MAX_INTERVAL} turns:`,
          err,
        );
      }
    }
  }

  // 11b. rolling checkpoint (§9.4 close trigger 3): every 12 turns the open
  //      session's memo refreshes in place, so a never-closed session still
  //      accrues Learned-layer content. Non-fatal like the cycle above.
  if (!g2.rolling_checkpoint) {
    try {
      await rollingCheckpoint(db, campaignId, turnNumber);
    } catch (err) {
      console.warn(`[g2] rolling checkpoint failed (turn ${turnNumber}):`, err);
    }
    g2.rolling_checkpoint = true;
    await markDb();
  }

  // 11c. sakkan (§4.5, C8): drift sampled on cadence — every 8 turns or a
  //      sakuga scene (session close hooks separately). Trust rule: advisory
  //      only; a failed sample is a skipped measurement, never a wedged G2.
  if (!g2.sakkan) {
    try {
      const direction = await loadDirectionState(db, campaignId);
      if (sakkanDue(direction, turnNumber, { sakuga: turn.tier === "sakuga" })) {
        await runSakkanSample(db, campaignId, turnNumber, {
          trigger: turn.tier === "sakuga" ? "sakuga" : "interval",
        });
      }
    } catch (err) {
      console.warn(`[g2] sakkan sample failed (turn ${turnNumber}):`, err);
    }
    g2.sakkan = true;
    await markDb();
  }

  // 12. media — the §9.5 disabled seam.
  if (!g2.media) {
    dispatchMediaTriggers();
    g2.media = true;
    await markDb();
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
