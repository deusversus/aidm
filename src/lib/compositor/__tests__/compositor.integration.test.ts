import { assembleBlocks, exchangesText } from "@/lib/blocks/assemble";
import {
  compactionWatermark,
  loadBeats,
  maybeCompact,
  workingWindow,
} from "@/lib/blocks/compaction";
import { settleG1 } from "@/lib/compositor/g1";
import { G2_MAX_STEP_ATTEMPTS, settleG2, settleG2IfPending } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { fetchCritical } from "@/lib/turn/retrieval";
import { attachToTurn, submitTurn } from "@/lib/turn/runtime";
import { Conte } from "@/lib/types/conte";
import { CommitScene } from "@/lib/types/sidecar";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Compositor (Chronicler write groups, §5.8) against real Postgres with
 * scripted models: G1's must-commit group settled before the done event, G2's
 * async group end-to-end with a scripted distiller, crash catch-up replaying
 * from the checkpoint payload, the C4 heat seam closed, and the real
 * subtext-first compactor. The ingestion + rewind seams are mocked so this
 * suite is green regardless of those agents' progress.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn(), streamNarration: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});
vi.mock("@/lib/ingestion/ingest", () => ({
  ingestAssertion: vi.fn(async () => ({ writes: [], flags: [] })),
}));
vi.mock("@/lib/turn/rewind", () => ({ writeSnapshotIfDue: vi.fn(async () => {}) }));

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockEmbed = vi.mocked(embedTexts);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[compositor] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

/** A 1024-dim (frozen EMBEDDING_DIMENSIONS) non-zero vector for insert. */
const VEC = () => Array.from({ length: 1024 }, (_, i) => ((i % 7) + 1) * 0.001);

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function kaRound(blocks: Block[], stopReason: "end_turn" | "tool_use") {
  return {
    stream: {
      on: (event: string, cb: (t: string) => void) => {
        if (event === "text") for (const b of blocks) if (b.type === "text") cb(b.text);
      },
    },
    done: async () => ({
      message: {
        content: blocks,
        stop_reason: stopReason,
        model: "scripted",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      prose: blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join(""),
      sidecar: null,
      fallbackUsed: false,
      refused: false,
      costUsd: 0,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

function distillCallCount(name: string): number {
  return mockJudgment.mock.calls.filter((c) => (c[1] as { name?: string })?.name === name).length;
}

describe.skipIf(!url)("Compositor (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(
    extra: Partial<typeof schema.campaigns.$inferInsert> = {},
  ): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "compositor fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
        ...extra,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "compositor@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      for (const id of campaignIds) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
      }
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(() => {
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockStream.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue([]);
  });

  /** Wait for a turn's detached G2 (fired by the runtime) to fully settle. */
  async function waitForG2(turnId: string, timeoutMs = 10_000): Promise<void> {
    if (!db) throw new Error("unreachable");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const [t] = await db
        .select({ checkpoints: schema.turns.checkpoints })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId));
      if ((t?.checkpoints as { g2?: { media?: boolean } })?.g2?.media) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("detached G2 did not settle in time");
  }

  // -------------------------------------------------------------------------
  // (1) G1 must-commit before the done event + idempotency
  // -------------------------------------------------------------------------

  it(
    "G1 settles resource spend + consequence + admitted cast BEFORE the done event",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await db.insert(schema.entities).values({
        campaignId,
        name: "Spike",
        entityType: "player",
        block: "Spike Spiegel — the man who left the syndicate.",
        state: { resources: { MP: { current: 100, max: 100 } } },
        turnId: 0,
        provenance: "sz_handoff",
        confidence: 1,
      });

      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockProbe.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "intent_triage")
          return Promise.resolve({
            intent: "EXPLORATION",
            action: "scan",
            epicness: 0.4,
            special_conditions: [],
            confidence: 0.9,
          }) as never;
        if (opts.name === "pacer_micro")
          return Promise.resolve({ beat_classification: "quiet", escalation: false }) as never;
        return Promise.reject(new Error(`unscripted probe ${opts.name}`)) as never;
      });
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "outcome_judgment")
          return Promise.resolve({
            success_level: "success",
            difficulty_class: 10,
            modifiers: [],
            narrative_weight: "SIGNIFICANT",
            consequence: "The syndicate now knows your face",
            cost: "20 MP",
            rationale: "scripted",
          }) as never;
        if (opts.name === "relevance_filter") return Promise.resolve({ scores: [] }) as never;
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "A quiet scan that cost more than it looked.",
            facts: [],
            entity_updates: [],
            confirmed_seed_descriptions: [],
            meta_comments: [],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });
      const sidecar = {
        scene_cast_delta: [
          { name: "Gren", action: "admit_to_catalog", note: "a saxophone player with a past" },
        ],
        decision_point: false,
        intended_seed_mentions: [],
        notable_beats: ["a face from the syndicate turned"],
      };
      mockStream.mockImplementation(() =>
        kaRound(
          [
            { type: "text", text: "The bar was almost empty. " },
            { type: "tool_use", id: "t1", name: "commit_scene", input: sidecar },
          ],
          "tool_use",
        ),
      );

      const { turnId } = await submitTurn(db, campaignId, "I scan the bar");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("turn hung")), 15_000);
        attachToTurn(turnId, (e) => {
          if (e.type === "done" || e.type === "error") {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // By the time `done` fired, settleG1 had committed (it runs before the
      // status-complete update + done emit).
      const cons = await db
        .select()
        .from(schema.consequences)
        .where(eq(schema.consequences.campaignId, campaignId));
      expect(cons).toHaveLength(1);
      expect(cons[0]?.description).toBe("The syndicate now knows your face");
      expect(cons[0]?.provenance).toBe("chronicler_g1");

      const [gren] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Gren")));
      expect(gren?.block).toContain("saxophone");

      const [pc] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Spike")));
      const pcState = pc?.state as {
        resources: { MP: { current: number } };
        lastAppliedTurn: number;
      };
      expect(pcState.resources.MP.current).toBe(80);
      expect(pcState.lastAppliedTurn).toBe(1);

      // Drain the runtime's detached G2 so its distiller call cannot leak into a
      // later test's mock-call count.
      await waitForG2(turnId);
    },
  );

  it(
    "settleG1 is idempotent: twice → one application of each effect",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await db.insert(schema.entities).values({
        campaignId,
        name: "Spike",
        entityType: "player",
        block: "",
        state: { resources: { MP: { current: 100, max: 100 } } },
        turnId: 0,
        provenance: "sz_handoff",
        confidence: 1,
      });

      const conte = Conte.parse({
        turn_id: 1,
        tier: "genga",
        outcome: {
          success_level: "success",
          difficulty_class: 10,
          narrative_weight: "SIGNIFICANT",
          consequence: "A debt was noticed",
          rationale: "x",
        },
        mechanics: { resource_spends: [{ resource: "MP", amount: 20 }] },
      });
      const sidecar = CommitScene.parse({
        decision_point: false,
        notable_beats: ["x"],
        scene_cast_delta: [{ name: "Julia", action: "admit_to_catalog", note: "an old flame" }],
      });

      const args = { campaignId, turnId: "unused", turnNumber: 1, conte, sidecar, profileIds: [] };
      await settleG1(db, args);
      await settleG1(db, args);

      const [pc] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Spike")));
      expect((pc?.state as { resources: { MP: { current: number } } }).resources.MP.current).toBe(
        80,
      );

      const cons = await db
        .select()
        .from(schema.consequences)
        .where(eq(schema.consequences.campaignId, campaignId));
      expect(cons).toHaveLength(1);

      const julia = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Julia")));
      expect(julia).toHaveLength(1);

      // Creation minted version 1 (C6 audit — the rewind restore base) …
      const juliaVersions = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, julia[0]?.id ?? ""));
      expect(juliaVersions).toHaveLength(1);
      expect(juliaVersions[0]?.block).toBe("an old flame");

      // … and a re-admit ENRICH writes the next version alongside the block
      // change (C6 re-audit: an unversioned enrich is silently clobbered by
      // the rewind block-restore). Run twice — still exactly one new version.
      const conte2 = Conte.parse({
        turn_id: 2,
        tier: "genga",
        outcome: {
          success_level: "success",
          difficulty_class: 10,
          narrative_weight: "SIGNIFICANT",
          rationale: "x",
        },
        mechanics: { resource_spends: [] },
      });
      const sidecar2 = CommitScene.parse({
        decision_point: false,
        notable_beats: ["x"],
        scene_cast_delta: [
          { name: "Julia", action: "admit_to_catalog", note: "seen at the cathedral" },
        ],
      });
      const args2 = {
        campaignId,
        turnId: "unused",
        turnNumber: 2,
        conte: conte2,
        sidecar: sidecar2,
        profileIds: [],
      };
      await settleG1(db, args2);
      await settleG1(db, args2);

      const [juliaAfter] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Julia")));
      expect(juliaAfter?.block).toBe("an old flame\nseen at the cathedral");
      const versionsAfter = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, juliaAfter?.id ?? ""));
      expect(versionsAfter.map((v) => v.version).sort()).toEqual([1, 2]);
      // The restore-loop invariant: living block == newest surviving version.
      expect(versionsAfter.find((v) => v.version === 2)?.block).toBe(juliaAfter?.block);
    },
  );

  it(
    "a reconstructed sidecar's admission enters the catalog demoted (M3 C1)",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      // Live 2026-08-01: a probe read a scene back from prose alone and filed
      // Shikō — present, alive, speaking — as "Kami's sister, deceased", and
      // the catalog carried that at 0.9 confidence into every later conte.
      // The row still gets written (real admissions ride the same path); it
      // just no longer claims to be the writer's own word.
      const campaignId = await makeCampaign();
      const conte = Conte.parse({ turn_id: 1, tier: "genga" });
      const admit = (name: string) =>
        CommitScene.parse({
          decision_point: false,
          notable_beats: ["x"],
          scene_cast_delta: [{ name, action: "admit_to_catalog", note: "a note" }],
        });

      await settleG1(db, {
        campaignId,
        turnId: "unused",
        turnNumber: 1,
        conte,
        sidecar: admit("Shiko"),
        trailerSource: "probe",
        profileIds: [],
      });
      await settleG1(db, {
        campaignId,
        turnId: "unused",
        turnNumber: 2,
        conte,
        sidecar: admit("Kami"),
        trailerSource: "native",
        profileIds: [],
      });
      await settleG1(db, {
        campaignId,
        turnId: "unused",
        turnNumber: 3,
        conte,
        sidecar: admit("Miwa"),
        trailerSource: "continuation",
        profileIds: [],
      });

      const rows = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.campaignId, campaignId));
      const reconstructed = rows.find((r) => r.name === "Shiko");
      const written = rows.find((r) => r.name === "Kami");
      const asked = rows.find((r) => r.name === "Miwa");

      expect(reconstructed?.provenance).toBe("sidecar_fallback");
      expect(Number(reconstructed?.confidence)).toBeCloseTo(0.6);
      // Native is untouched — the demotion is a distinction, not a blanket.
      expect(written?.provenance).toBe("chronicler_g1");
      expect(Number(written?.confidence)).toBeCloseTo(0.9);
      // The CONTINUATION is the writer answering for its own scene — the
      // writer's testimony whether volunteered or asked for. Only the probe's
      // read-back demotes (M3 C1 ruling, 2026-08-01).
      expect(asked?.provenance).toBe("chronicler_g1");
      expect(Number(asked?.confidence)).toBeCloseTo(0.9);

      // The version row carries the same envelope as its entity.
      const versions = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, reconstructed?.id ?? ""));
      expect(versions[0]?.provenance).toBe("sidecar_fallback");
      expect(Number(versions[0]?.confidence)).toBeCloseTo(0.6);
    },
  );

  // -------------------------------------------------------------------------
  // (2) G2 end-to-end with a scripted distiller
  // -------------------------------------------------------------------------

  it(
    "settleG2 distills: fragment, semantic+categories, promotion, entities, spotlight, seeds, marks",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const turnNumber = 3;
      const narration =
        "The bar went quiet. Jet set down his drink. Ryū watched from the corner. On the wall, the bounty on Vicious stared back.";
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I tell Jet the truth",
          narration,
          sidecar: CommitScene.parse({
            decision_point: false,
            notable_beats: ["a confession lands"],
            intended_seed_mentions: [],
          }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I tell Jet the truth",
        narration,
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });
      await db.insert(schema.entities).values([
        {
          campaignId,
          name: "Jet",
          entityType: "npc",
          block: "Jet Black — the other half of the Bebop.",
          state: { spotlightDebt: 0 },
          turnId: 0,
          provenance: "sz_handoff",
          confidence: 1,
        },
        {
          campaignId,
          name: "Faye",
          entityType: "npc",
          block: "Faye Valentine.",
          state: { spotlightDebt: 2 },
          turnId: 0,
          provenance: "sz_handoff",
          confidence: 1,
        },
        {
          campaignId,
          name: "Ryū",
          entityType: "npc",
          block: "Ryū — a silent enforcer.",
          state: { spotlightDebt: 1 },
          turnId: 0,
          provenance: "sz_handoff",
          confidence: 1,
        },
      ]);
      await db.insert(schema.seeds).values({
        campaignId,
        description: "The unclaimed bounty on Vicious",
        status: "planted",
        plantedTurn: 1,
        urgency: 0,
        mentionCount: 0,
        turnId: 1,
        provenance: "director",
        confidence: 0.8,
      });

      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "Spike finally said the quiet part; Jet heard the cost in it.",
            facts: [
              {
                content: "Spike owes the Red Dragon Syndicate a blood debt",
                category: "relationship",
                is_plot_critical: true,
                critical_reason: "the debt drives the finale",
              },
              {
                content: "The Blue Crow bar sits in the Martian sprawl",
                category: "location",
                is_plot_critical: false,
              },
            ],
            entity_updates: [
              {
                name: "Jet",
                note: "heard Spike's confession and went cold",
                relationship_shift: "trust -1",
              },
            ],
            confirmed_seed_descriptions: ["bounty on Vicious"],
            meta_comments: ["less flowery please"],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });
      // §7.6 declared detection: the sidecar/distiller NAME seeds; this probe
      // reads the page and confirms which of them actually surfaced.
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockProbe.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "seed_mention_check") return Promise.resolve({ surfaced: [0] }) as never;
        return Promise.reject(new Error(`unscripted probe ${opts.name}`)) as never;
      });

      await settleG2(db, turnRow.id);

      const [ep] = await db
        .select()
        .from(schema.episodicRecords)
        .where(
          and(
            eq(schema.episodicRecords.campaignId, campaignId),
            eq(schema.episodicRecords.turnNumber, turnNumber),
          ),
        );
      expect(ep?.narratedFragment).toBe(
        "Spike finally said the quiet part; Jet heard the cost in it.",
      );

      const sem = await db
        .select()
        .from(schema.semanticMemories)
        .where(eq(schema.semanticMemories.campaignId, campaignId));
      expect(sem).toHaveLength(2);
      const rel = sem.find((s) => s.category === "relationship");
      const loc = sem.find((s) => s.category === "location");
      expect(rel?.plotCritical).toBe(true);
      expect(rel?.heatFloor).toBe(40); // plot-critical relationship floor (v3)
      expect(rel?.baseHeat).toBe(100);
      expect(rel?.lastBoostedTurn).toBe(turnNumber);
      expect(rel?.provenance).toBe("chronicler_g2");
      expect(rel?.confidence).toBeCloseTo(0.8);
      expect(loc?.heatFloor).toBe(1);
      expect(loc?.plotCritical).toBe(false);

      // Promotion round-trip: the plot-critical fact is ALSO in the Critical
      // layer, and the Critical reader surfaces it.
      const crit = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, campaignId));
      expect(crit).toHaveLength(1);
      expect(crit[0]?.category).toBe("promoted");
      expect(crit[0]?.provenance).toBe("chronicler_promotion");
      const surfaced = await fetchCritical(db, campaignId);
      expect(surfaced).toContain("Spike owes the Red Dragon Syndicate a blood debt");

      // Entity enrichment + version row + spotlight debt.
      const [jet] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Jet")));
      expect(jet?.block).toContain("heard Spike's confession");
      const jetState = jet?.state as {
        relationships: Record<string, string>;
        interiorityEvents: number;
        spotlightDebt: number;
      };
      expect(jetState.relationships[String(turnNumber)]).toBe("trust -1");
      expect(jetState.interiorityEvents).toBe(1);
      expect(jetState.spotlightDebt).toBe(0); // present in the scene
      const jetVersions = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, jet?.id ?? ""));
      expect(jetVersions).toHaveLength(1);
      expect(jetVersions[0]?.version).toBe(1);

      const [faye] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Faye")));
      expect((faye?.state as { spotlightDebt: number }).spotlightDebt).toBe(3); // absent → +1

      // Non-ASCII name in the narration still registers as present — ASCII \b
      // never matched a trailing macron, so "Ryū" accrued phantom debt every
      // scene he actually appeared in (C6 re-audit).
      const [ryu] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Ryū")));
      expect((ryu?.state as { spotlightDebt: number }).spotlightDebt).toBe(0);

      // Seed confirmation — via the §7.6 probe, not the distiller's word.
      const [seed] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.campaignId, campaignId));
      expect(seed?.status).toBe("confirmed");
      expect(seed?.mentionCount).toBe(1);
      expect(seed?.urgency).toBeCloseTo(0.1);
      expect(
        mockProbe.mock.calls.filter(
          (c) => (c[1] as { name?: string })?.name === "seed_mention_check",
        ),
      ).toHaveLength(1);
      // The declared path won the turn OUTRIGHT (§7.6 double-billing
      // exclusion, ruled 2026-08-01): a probe-confirmed seed is skipped by
      // the sweep entirely — no candidate, and its lazy backfill defers to
      // the first turn it is NOT declared (it needs no embedding while the
      // stronger evidence keeps winning). Known cost, accepted: declared
      // co-occurrence is invisible to candidate-turn overlap; the embedding
      // leg of convergence still covers those pairs.
      expect(seed?.embedding).toBeNull();
      expect(seed?.candidates as unknown[]).toEqual([]);

      // Meta comment → pencil mark.
      const marks = await db
        .select()
        .from(schema.pencilMarks)
        .where(
          and(
            eq(schema.pencilMarks.campaignId, campaignId),
            eq(schema.pencilMarks.topic, "player_meta"),
          ),
        );
      expect(marks).toHaveLength(1);
      expect(marks[0]?.direction).toBe("less flowery please");

      // G2 ran to completion.
      const [after] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      expect((after?.checkpoints as { g2?: { media?: boolean } }).g2?.media).toBe(true);
      expect(distillCallCount("g2_distill")).toBe(1);
    },
  );

  it(
    "an over-count distill CLAMPS and settles — G2 is never lost to a ninth fact (2026-08-01)",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      // The grammar strips maxItems, so `.max(8)` on facts could never hold the
      // distiller to eight — only fail the parse and throw away the whole G2
      // artifact: fragment, semantic layer, promotions, seeds, marks.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const campaignId = await makeCampaign();
      const turnNumber = 6;
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I read the whole file",
          narration: "The file was longer than anyone wanted it to be.",
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["a long read"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I read the whole file",
        narration: "The file was longer than anyone wanted it to be.",
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "Everything in the file pointed one way.",
            facts: Array.from({ length: 12 }, (_, i) => ({
              content: `fact ${i}`,
              category: "event",
              is_plot_critical: false,
            })),
            entity_updates: Array.from({ length: 6 }, (_, i) => ({
              name: `ghost ${i}`,
              note: "not in the catalog",
            })),
            confirmed_seed_descriptions: [],
            meta_comments: [],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });

      await settleG2(db, turnRow.id);

      const [done] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      expect((done?.checkpoints as { g2?: { media?: boolean } }).g2?.media).toBe(true);
      const sem = await db
        .select()
        .from(schema.semanticMemories)
        .where(eq(schema.semanticMemories.campaignId, campaignId));
      expect(sem).toHaveLength(8);
      // The clamp lands BEFORE the stash, so crash-replay reads the same shape.
      const payload = (done?.checkpoints as { g2_payload?: { facts?: unknown[] } }).g2_payload;
      expect(payload?.facts).toHaveLength(8);
      warn.mockRestore();
    },
  );

  it(
    "step hygiene (M3R2 C5): a failing step marks nothing, isolates, defers its dependents, and never wedges the next submit",
    { timeout: 45_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const campaignId = await makeCampaign();
      const turnNumber = 9;
      const narration = "The embedding service was, that evening, extremely unavailable.";
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I file the report",
          narration,
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["a filing"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I file the report",
        narration,
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      const distill = {
        narrated_fragment: "Nothing was written down that could be written down.",
        facts: [
          {
            content: "The report names the dockmaster",
            category: "event",
            is_plot_critical: true,
            critical_reason: "it is the thread",
          },
        ],
        entity_updates: [],
        confirmed_seed_descriptions: [],
        meta_comments: ["less flowery please"],
      };
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill") return Promise.resolve(distill) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });
      // The semantic step's embedder is down. Before C5 this THREW out of
      // settleG2 — every later step was skipped and submitTurn 500'd.
      mockEmbed.mockRejectedValue(new Error("voyage unavailable"));

      await expect(settleG2(db, turnRow.id)).resolves.toBeUndefined();

      const readCheckpoints = async () => {
        const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
        return (row?.checkpoints ?? {}) as {
          g2?: Record<string, boolean>;
          g2_attempts?: Record<string, number>;
          g2_abandoned?: Record<string, string>;
        };
      };

      const first = await readCheckpoints();
      // The failed step marked NOTHING and counted its attempt.
      expect(first.g2?.semantic).toBeUndefined();
      expect(first.g2_attempts?.semantic).toBe(1);
      // Its dependent was DEFERRED, not run against an empty layer.
      expect(first.g2?.promotion).toBeUndefined();
      // Isolation: everything independent of it still ran.
      expect(first.g2?.distill).toBe(true);
      expect(first.g2?.fragment).toBe(true);
      expect(first.g2?.entities).toBe(true);
      expect(first.g2?.marks).toBe(true);
      expect(first.g2?.heat_batch).toBe(true);
      expect(first.g2?.director_trigger).toBe(true);
      // The TERMINAL marker is withheld — the catch-up must still see this turn.
      expect(first.g2?.media).toBeUndefined();

      // …and the next submit's drain does not throw on it.
      await expect(settleG2IfPending(db, campaignId)).resolves.toBeUndefined();
      const second = await readCheckpoints();
      expect(second.g2_attempts?.semantic).toBe(2);
      expect(second.g2?.media).toBeUndefined();

      // Service restored: the retry lands, its dependent follows, the turn
      // reaches its terminal marker — and the distiller is NOT re-billed.
      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
      await settleG2IfPending(db, campaignId);

      const done = await readCheckpoints();
      expect(done.g2?.semantic).toBe(true);
      expect(done.g2?.promotion).toBe(true);
      expect(done.g2?.media).toBe(true);
      expect(done.g2_abandoned ?? {}).toEqual({});
      expect(distillCallCount("g2_distill")).toBe(1);

      const promoted = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, campaignId));
      expect(promoted.some((c) => c.content.includes("dockmaster"))).toBe(true);

      errorLog.mockRestore();
      warnLog.mockRestore();
    },
  );

  it(
    "step hygiene: a PERMANENTLY failing step is abandoned after its attempts, not retried forever",
    { timeout: 45_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const campaignId = await makeCampaign();
      const turnNumber = 11;
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "x",
          narration: "y",
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "x",
        narration: "y",
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      // The distiller itself is unsatisfiable — a poisoned turn. Retrying it
      // at every submit for the life of the campaign would BILL a judgment
      // call each time; the bound is what makes "never mark a failure done"
      // affordable.
      mockJudgment.mockImplementation(
        () => Promise.reject(new Error("permanent distill failure")) as never,
      );
      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));

      for (let i = 0; i < G2_MAX_STEP_ATTEMPTS; i++) {
        await expect(settleG2IfPending(db, campaignId)).resolves.toBeUndefined();
      }
      const callsAfterBound = distillCallCount("g2_distill");
      expect(callsAfterBound).toBe(G2_MAX_STEP_ATTEMPTS);

      const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      const cps = (row?.checkpoints ?? {}) as {
        g2?: Record<string, boolean>;
        g2_abandoned?: Record<string, string>;
      };
      expect(cps.g2_abandoned?.distill).toContain("permanent distill failure");
      // Abandoned counts as settled: the terminal marker lands so the drain
      // stops re-scanning — loudly (the abandoned map is on the row).
      expect(cps.g2?.media).toBe(true);
      expect(cps.g2?.distill).toBeUndefined();

      // A further drain costs NOTHING — no fourth distill call.
      await settleG2IfPending(db, campaignId);
      expect(distillCallCount("g2_distill")).toBe(callsAfterBound);

      errorLog.mockRestore();
      warnLog.mockRestore();
    },
  );

  it(
    "a transaction that fails at its own marker update persists NEITHER the marker nor its writes (M3R3 close)",
    { timeout: 45_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const campaignId = await makeCampaign();
      const turnNumber = 13;
      const narration = "The ledger closed a beat before the money did.";
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I check the books",
          narration,
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["a discrepancy"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I check the books",
        narration,
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "Somebody had already been here with a pen.",
            facts: [
              {
                content: "The ledger's last page was rewritten",
                category: "event",
                is_plot_critical: true,
                critical_reason: "it is the thread",
              },
            ],
            entity_updates: [],
            confirmed_seed_descriptions: [],
            meta_comments: [],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });
      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));

      // Fault injection on a REAL connection, not a mocked DB: the real
      // transaction runs, and only the CLOSING checkpoint update inside it
      // throws — the exact failure the marker rule exists for (that update, or
      // the COMMIT behind it, going down after the step's writes are staged).
      // Before the fix the step had already set its marker on the SHARED map,
      // so the catch serialized "semantic: done" while its rows rolled back:
      // a fact lost forever, and nothing left that would ever retry it.
      let injected = 0;
      const faulty = new Proxy(db, {
        get(target, prop) {
          if (prop !== "transaction") {
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          }
          // biome-ignore lint/suspicious/noExplicitAny: drizzle's tx generics
          return (cb: (tx: any) => Promise<unknown>) =>
            // biome-ignore lint/suspicious/noExplicitAny: drizzle's tx generics
            target.transaction(async (tx: any) => {
              const guarded = new Proxy(tx, {
                get(t: object, p: string | symbol) {
                  const value = Reflect.get(t, p);
                  if (p !== "update" || typeof value !== "function") {
                    return typeof value === "function" ? value.bind(t) : value;
                  }
                  return (table: unknown) => {
                    if (table === schema.turns && injected++ === 0) {
                      throw new Error("checkpoint update lost the connection (scripted)");
                    }
                    return value.call(t, table);
                  };
                },
              });
              return cb(guarded);
            });
        },
      });

      await expect(settleG2(faulty, turnRow.id)).resolves.toBeUndefined();
      expect(injected).toBeGreaterThan(0);

      const readCheckpoints = async () => {
        const [row] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
        return (row?.checkpoints ?? {}) as {
          g2?: Record<string, boolean>;
          g2_attempts?: Record<string, number>;
        };
      };
      const readSemantic = () =>
        db
          .select()
          .from(schema.semanticMemories)
          .where(eq(schema.semanticMemories.campaignId, campaignId));

      const failed = await readCheckpoints();
      // THE REGRESSION: no marker, and the attempt counted.
      expect(failed.g2?.semantic).toBeUndefined();
      expect(failed.g2_attempts?.semantic).toBe(1);
      // The rollback was real — the rows the marker would have claimed are gone.
      expect(await readSemantic()).toHaveLength(0);
      // Its reader deferred rather than promoting from an empty layer, and the
      // terminal marker stayed withheld so the drain comes back for this turn.
      expect(failed.g2?.promotion).toBeUndefined();
      expect(failed.g2?.media).toBeUndefined();
      // Isolation intact: the steps whose transactions committed are marked —
      // the failure poisoned nothing, in either direction.
      expect(failed.g2?.distill).toBe(true);
      expect(failed.g2?.entities).toBe(true);
      expect(failed.g2?.heat_batch).toBe(true);

      // …and because the marker never landed, the next settle RETRIES it. This
      // is what the persisted lie used to cost: the fact was unrecoverable.
      await settleG2IfPending(db, campaignId);
      const settled = await readCheckpoints();
      expect(settled.g2?.semantic).toBe(true);
      expect(settled.g2?.promotion).toBe(true);
      expect(settled.g2?.media).toBe(true);
      const rows = await readSemantic();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toContain("last page was rewritten");
      // One distill call across both settles — the retry re-billed nothing.
      expect(distillCallCount("g2_distill")).toBe(1);

      errorLog.mockRestore();
      warnLog.mockRestore();
    },
  );

  // -------------------------------------------------------------------------
  // (3) G2 catch-up after a crash — replays from the checkpoint payload
  // -------------------------------------------------------------------------

  it(
    "crash mid-G2 persists partial markers; catch-up finishes WITHOUT re-distilling",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const turnNumber = 4;
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I check the manifest",
          narration: "The manifest listed one name too many.",
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["a discrepancy"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I check the manifest",
        narration: "The manifest listed one name too many.",
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "The books did not add up, and everyone knew it.",
            facts: [
              {
                content: "The manifest has a phantom passenger",
                category: "event",
                is_plot_critical: false,
              },
            ],
            entity_updates: [],
            confirmed_seed_descriptions: [],
            meta_comments: [],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });
      // Voyage throws on the FIRST embed (step 3), then recovers.
      mockEmbed.mockReset();
      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));
      mockEmbed.mockImplementationOnce(() => Promise.reject(new Error("voyage down (scripted)")));

      // M3R2 C5 re-baseline: the settle no longer PROPAGATES a step failure —
      // it is awaited inside submitTurn, so a throw here 500'd the player's
      // next turn. The failure is isolated and recorded instead; the partial
      // markers (and the un-marked semantic step) are unchanged.
      await expect(settleG2(db, turnRow.id)).resolves.toBeUndefined();

      const [mid] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      const midCk = mid?.checkpoints as {
        g2?: Record<string, boolean>;
        g2_payload?: unknown;
        g2_attempts?: Record<string, number>;
      };
      expect(midCk.g2?.distill).toBe(true);
      expect(midCk.g2?.fragment).toBe(true);
      expect(midCk.g2?.semantic).toBeUndefined();
      expect(midCk.g2_attempts?.semantic).toBe(1);
      // The terminal marker is withheld, which is what makes the catch-up
      // below pick this turn up at all.
      expect(midCk.g2?.media).toBeUndefined();
      expect(midCk.g2_payload).toBeTruthy();
      expect(distillCallCount("g2_distill")).toBe(1);

      // Catch-up completes the rest, replaying the stashed payload.
      await settleG2IfPending(db, campaignId);

      expect(distillCallCount("g2_distill")).toBe(1); // NOT re-called
      const [done] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      expect((done?.checkpoints as { g2?: { media?: boolean } }).g2?.media).toBe(true);
      const sem = await db
        .select()
        .from(schema.semanticMemories)
        .where(eq(schema.semanticMemories.campaignId, campaignId));
      expect(sem).toHaveLength(1);
      expect(sem[0]?.category).toBe("event");
    },
  );

  it(
    "catch-up AWAITS an in-flight settle instead of skipping it (§5.8, live-run regression)",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber: 9,
          tier: "genga",
          status: "complete",
          playerInput: "I wait",
          narration: "The waiting was its own kind of answer.",
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["stillness"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber: 9,
        playerInput: "I wait",
        narration: "The waiting was its own kind of answer.",
        turnId: 9,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      // Gate the distiller so the detached settle is IN FLIGHT when the
      // catch-up runs — IfPending must not resolve until the settle does.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation(async (_s: any, opts: any) => {
        if (opts.name === "g2_distill") {
          await gate;
          return {
            narrated_fragment: "Stillness, weaponized.",
            facts: [],
            entity_updates: [],
            confirmed_seed_descriptions: [],
            meta_comments: [],
          } as never;
        }
        throw new Error(`unscripted judgment ${opts.name}`);
      });
      mockEmbed.mockReset();
      mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => VEC())));

      const detached = settleG2(db, turnRow.id); // in flight, gated
      let caughtUp = false;
      const catchUp = settleG2IfPending(db, campaignId).then(() => {
        caughtUp = true;
      });
      // Give the catch-up a beat: it must be WAITING, not returned-early.
      await new Promise((r) => setTimeout(r, 150));
      expect(caughtUp).toBe(false);
      release();
      await Promise.all([detached, catchUp]);
      expect(caughtUp).toBe(true);
      expect(distillCallCount("g2_distill")).toBe(1); // one settle, shared
      const [done] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      expect((done?.checkpoints as { g2?: { media?: boolean } }).g2?.media).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // (4) Heat batch — the closed C4 seam
  // -------------------------------------------------------------------------

  it(
    "heat_batch folds accumulated boosts into base heat (capped at 100) and deletes them",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const [mem] = await db
        .insert(schema.semanticMemories)
        .values({
          campaignId,
          content: "an old, oft-recalled fact",
          embedding: VEC(),
          category: "event",
          baseHeat: 90,
          heatFloor: 1,
          lastBoostedTurn: 0,
          plotCritical: false,
          turnId: 1,
          provenance: "chronicler_g2",
          confidence: 0.8,
        })
        .returning({ id: schema.semanticMemories.id });
      if (!mem) throw new Error("memory insert failed");
      await db.insert(schema.heatBoosts).values([
        { campaignId, memoryId: mem.id, boost: 30, turnNumber: 3 },
        { campaignId, memoryId: mem.id, boost: 20, turnNumber: 4 },
      ]);

      const turnNumber = 5;
      const [turnRow] = await db
        .insert(schema.turns)
        .values({
          campaignId,
          turnNumber,
          tier: "genga",
          status: "complete",
          playerInput: "I remember",
          narration: "Some things do not fade.",
          sidecar: CommitScene.parse({ decision_point: false, notable_beats: ["a recollection"] }),
          checkpoints: { phase_a: true, phase_b: true, g1: true },
        })
        .returning({ id: schema.turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber,
        playerInput: "I remember",
        narration: "Some things do not fade.",
        turnId: turnNumber,
        provenance: "chronicler_g1",
        confidence: 1,
      });

      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "g2_distill")
          return Promise.resolve({
            narrated_fragment: "A memory, undimmed.",
            facts: [],
            entity_updates: [],
            confirmed_seed_descriptions: [],
            meta_comments: [],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });

      await settleG2(db, turnRow.id);

      const [after] = await db
        .select()
        .from(schema.semanticMemories)
        .where(eq(schema.semanticMemories.id, mem.id));
      expect(after?.baseHeat).toBe(100); // 90 + 30 + 20 = 140, capped
      expect(after?.lastBoostedTurn).toBe(4); // GREATEST(0, 3, 4)
      const remaining = await db
        .select()
        .from(schema.heatBoosts)
        .where(eq(schema.heatBoosts.campaignId, campaignId));
      expect(remaining).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // (5) The real compactor — subtext-first beats, watermark advance
  // -------------------------------------------------------------------------

  it(
    "maybeCompact writes narrated beats past the 12-exchange window; newest 12 remain",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      // 21 exchanges: past the hysteresis trigger (20), compacting down to
      // the keep-tail (12) in ONE batched event — §5.6's sanctioned cadence,
      // never a per-turn trickle. RE-BASELINED for the 32k window ruling
      // (user, 2026-08-05): 16/10 scaled to 20/12 with the doubled ceiling.
      await db.insert(schema.episodicRecords).values(
        Array.from({ length: 21 }, (_, i) => ({
          campaignId,
          turnNumber: i + 1,
          playerInput: `input ${i + 1}`,
          narration: `Narration for turn ${i + 1}, with enough texture to matter.`,
          turnId: i + 1,
          provenance: "chronicler_g1",
          confidence: 1,
        })),
      );

      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) => {
        if (opts.name === "compact_beats")
          return Promise.resolve({
            beats: [
              "The crew learned the found money was never really theirs.",
              "Old debts surfaced, and trust on the Bebop began to fray.",
            ],
          }) as never;
        return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
      });

      expect(await compactionWatermark(db, campaignId)).toBe(0);
      const report = await maybeCompact(db, campaignId, 21, SELECTION);
      expect(report.compacted).toBe(true);
      expect(report.exchangesCompacted).toBe(9); // 21 − keepTail(12), one batch
      expect(report.beatsWritten).toBe(2);

      expect(await compactionWatermark(db, campaignId)).toBe(9);
      const window = await workingWindow(db, campaignId);
      expect(window.map((e) => e.turnNumber)).toEqual([
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);

      // Hysteresis: at exactly the keep-tail the next call is a NO-OP — the
      // cadence is batched (~every 8 turns), never a per-turn trickle.
      const followUp = await maybeCompact(db, campaignId, 21, SELECTION);
      expect(followUp.compacted).toBe(false);

      const beats = await db
        .select()
        .from(schema.compactedBeats)
        .where(eq(schema.compactedBeats.campaignId, campaignId))
        .orderBy(asc(schema.compactedBeats.position));
      expect(beats).toHaveLength(2);
      expect(beats[0]?.provenance).toBe("chronicler_compaction");
      expect(beats[0]?.fromTurn).toBe(1);
      expect(beats[0]?.toTurn).toBe(9);
      // Position-ordered — Block 2's content ordering is deterministic.
      expect((beats[0]?.position ?? 0) < (beats[1]?.position ?? 0)).toBe(true);

      // Block-2 prefix stability: appending a new exchange leaves B2 untouched
      // (B2 changes only at compaction events, §5.6).
      const loaded = await loadBeats(db, campaignId);
      const watermark = await compactionWatermark(db, campaignId);
      const before = assembleBlocks({
        settei: "# S",
        beats: loaded,
        exchanges: window,
        pins: [],
        watermark,
      });
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber: 22,
        playerInput: "input 22",
        narration: "Narration for turn 22.",
        turnId: 22,
        provenance: "chronicler_g1",
        confidence: 1,
      });
      const after = assembleBlocks({
        settei: "# S",
        beats: loaded,
        exchanges: await workingWindow(db, campaignId),
        pins: [],
        watermark,
      });
      expect(after.system[1]?.text).toBe(before.system[1]?.text);
      // Post-C3 B3 is a block LIST; the prefix property lives on its
      // concatenation (system[2] alone is the constant window header —
      // asserting on it proved nothing).
      expect(
        exchangesText(after.exchangeMessages).startsWith(exchangesText(before.exchangeMessages)),
      ).toBe(true);
    },
  );
});
