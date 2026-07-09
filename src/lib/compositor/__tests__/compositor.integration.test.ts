import { assembleBlocks } from "@/lib/blocks/assemble";
import {
  compactionWatermark,
  loadBeats,
  maybeCompact,
  workingWindow,
} from "@/lib/blocks/compaction";
import { settleG1 } from "@/lib/compositor/g1";
import { settleG2, settleG2IfPending } from "@/lib/compositor/g2";
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
        "The bar went quiet. Jet set down his drink. On the wall, the bounty on Vicious stared back.";
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

      // Seed confirmation.
      const [seed] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.campaignId, campaignId));
      expect(seed?.status).toBe("confirmed");
      expect(seed?.mentionCount).toBe(1);
      expect(seed?.urgency).toBeCloseTo(0.1);

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

      await expect(settleG2(db, turnRow.id)).rejects.toThrow(/voyage down/);

      const [mid] = await db.select().from(schema.turns).where(eq(schema.turns.id, turnRow.id));
      const midCk = mid?.checkpoints as { g2?: Record<string, boolean>; g2_payload?: unknown };
      expect(midCk.g2?.distill).toBe(true);
      expect(midCk.g2?.fragment).toBe(true);
      expect(midCk.g2?.semantic).toBeUndefined();
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
    "maybeCompact writes narrated beats past the 10-exchange window; newest 10 remain",
    { timeout: 30_000 },
    async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      // 17 exchanges: past the hysteresis trigger (16), compacting down to
      // the keep-tail (10) in ONE batched event — §5.6's sanctioned cadence,
      // never a per-turn trickle.
      await db.insert(schema.episodicRecords).values(
        Array.from({ length: 17 }, (_, i) => ({
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
      const report = await maybeCompact(db, campaignId, 17, SELECTION);
      expect(report.compacted).toBe(true);
      expect(report.exchangesCompacted).toBe(7); // 17 − keepTail(10), one batch
      expect(report.beatsWritten).toBe(2);

      expect(await compactionWatermark(db, campaignId)).toBe(7);
      const window = await workingWindow(db, campaignId);
      expect(window.map((e) => e.turnNumber)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

      // Hysteresis: at exactly the keep-tail the next call is a NO-OP — the
      // cadence is batched (~every 6 turns), never a per-turn trickle.
      const followUp = await maybeCompact(db, campaignId, 17, SELECTION);
      expect(followUp.compacted).toBe(false);

      const beats = await db
        .select()
        .from(schema.compactedBeats)
        .where(eq(schema.compactedBeats.campaignId, campaignId))
        .orderBy(asc(schema.compactedBeats.position));
      expect(beats).toHaveLength(2);
      expect(beats[0]?.provenance).toBe("chronicler_compaction");
      expect(beats[0]?.fromTurn).toBe(1);
      expect(beats[0]?.toTurn).toBe(7);
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
        turnNumber: 18,
        playerInput: "input 18",
        narration: "Narration for turn 18.",
        turnId: 18,
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
      expect(after.system[2]?.text.startsWith(before.system[2]?.text ?? "!")).toBe(true);
    },
  );
});
