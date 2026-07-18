import { assembleForCampaign } from "@/lib/blocks/campaign";
import { loadBeats, maybeCompact } from "@/lib/blocks/compaction";
import { settleG2IfPending } from "@/lib/compositor/g2";
import * as schema from "@/lib/db/schema";
import { runDirectorCycle } from "@/lib/direction/director";
import { plantSeed } from "@/lib/direction/seeds";
import { closeSession } from "@/lib/direction/session";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { runConductorTurn } from "@/lib/sz/conductor";
import { type TurnEvent, attachToTurn, submitTurn } from "@/lib/turn/runtime";
import { executeGetTurnNarrative, executeRecallScene } from "@/lib/turn/tools";
import { Conte } from "@/lib/types/conte";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * §6.8 ROUND-TRIP FLYWHEEL TEST — the M1 gate.
 *
 * For each of the nine memory layers plus the §6.9 cross-campaign player
 * profile, ONE named test proves WRITER → READER through the REAL turn loop:
 * content is planted by the normal machinery on an early turn (or by the layer's
 * real writer), then a LATER scripted turn (or the reader's real consumer)
 * surfaces it. The assertion is on the SURFACED artifact — the conte the KA
 * would read, the block the assembler renders, the tool's return, the dossier
 * the Director reads, the conductor's system prompt — never the DB row alone.
 *
 * Real Postgres; the model trio + Voyage are mocked (never a live model call).
 * The KA runs its real tool loop over a scripted `streamNarration`. Basis-vector
 * (one-hot) embeddings make semantic/canon ranking deterministic: every planted
 * fact and every query maps to the same unit vector, so cosine distance is 0.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn(), streamNarration: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});
vi.mock("@/lib/turn/rewind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/turn/rewind")>();
  return { ...actual, writeSnapshotIfDue: vi.fn(async () => {}) };
});

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockEmbed = vi.mocked(embedTexts);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[flywheel] DATABASE_URL not set — skipping the M1 gate suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

// One-hot basis vector: every planted fact and every query embeds to THIS, so
// pgvector cosine distance is 0 and the planted row always ranks first.
const DIM = 1024;
const ONEHOT = Array.from({ length: DIM }, (_, i) => (i === 7 ? 1 : 0));

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

/** A plain, tool-free narration turn (the conductor / yokoku path). */
function plainRound(text: string) {
  return kaRound([{ type: "text", text }], "end_turn");
}

interface ArmOpts {
  intent?: string;
  epicness?: number;
  outcomeConsequence?: string;
  distillFacts?: { content: string; category: string; is_plot_critical: boolean }[];
  metaComments?: string[];
  castDelta?: { name: string; action: string; note?: string }[];
  prose?: string;
}

/** Scripts the full story-turn model surface for one intent/tier. */
function armModels(o: ArmOpts = {}): void {
  const intent = o.intent ?? "EXPLORATION";
  const epicness = o.epicness ?? 0.3;
  mockEmbed.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => [...ONEHOT])));
  // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic model-call signatures
  mockProbe.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "intent_triage")
      return Promise.resolve({
        intent,
        action: "act",
        epicness,
        special_conditions: [],
        confidence: 0.9,
      }) as never;
    if (opts.name === "pacer_micro")
      return Promise.resolve({
        beat_classification: "quiet",
        strength: "suggestion",
        must_reference: [],
        avoid: [],
      }) as never;
    if (opts.name === "arc_transition_check")
      return Promise.resolve({ transitioned: false }) as never;
    if (opts.name === "sidecar_fallback")
      return Promise.resolve({
        scene_cast_delta: [],
        decision_point: false,
        intended_seed_mentions: [],
        notable_beats: ["beat"],
      }) as never;
    return Promise.reject(new Error(`unscripted probe ${opts.name}`)) as never;
  });
  // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic model-call signatures
  mockJudgment.mockImplementation((_s: any, opts: any) => {
    if (opts.name === "outcome_judgment")
      return Promise.resolve({
        success_level: "success",
        difficulty_class: 10,
        modifiers: [],
        narrative_weight: "MINOR",
        rationale: "scripted",
        ...(o.outcomeConsequence ? { consequence: o.outcomeConsequence } : {}),
      }) as never;
    if (opts.name === "relevance_filter") return Promise.resolve({ scores: [] }) as never;
    if (opts.name === "g2_distill")
      return Promise.resolve({
        narrated_fragment: "what the scene meant",
        facts: o.distillFacts ?? [],
        entity_updates: [],
        confirmed_seed_descriptions: [],
        meta_comments: o.metaComments ?? [],
      }) as never;
    return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
  });
  mockStream.mockImplementation(() =>
    kaRound(
      [
        { type: "text", text: o.prose ?? "The scene lands, and the ship keeps drifting. " },
        {
          type: "tool_use",
          id: "t1",
          name: "commit_scene",
          input: {
            decision_point: false,
            notable_beats: ["x"],
            scene_cast_delta: o.castDelta ?? [],
            intended_seed_mentions: [],
          },
        },
      ],
      "tool_use",
    ),
  );
}

async function collectTurn(
  db2: NonNullable<typeof db>,
  campaignId: string,
  input: string,
): Promise<{ events: TurnEvent[]; turnId: string }> {
  const { turnId } = await submitTurn(db2, campaignId, input);
  const events: TurnEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn hung")), 20_000);
    attachToTurn(turnId, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "error" || e.type === "channel") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { events, turnId };
}

async function readConte(
  db2: NonNullable<typeof db>,
  campaignId: string,
  turnNumber: number,
): Promise<Conte> {
  const [row] = await db2
    .select({ conte: schema.turns.conte })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.turnNumber, turnNumber)));
  if (!row?.conte) throw new Error(`no conte on turn ${turnNumber}`);
  return Conte.parse(row.conte);
}

describe.skipIf(!url)(
  "§6.8 flywheel round-trip — the M1 gate (real Postgres, scripted models)",
  () => {
    const playerId = `test_player_${crypto.randomUUID()}`;
    const campaignIds: string[] = [];
    const canonProfileIds: string[] = [];

    async function makeCampaign(
      extra: Partial<typeof schema.campaigns.$inferInsert> = {},
    ): Promise<string> {
      if (!db) throw new Error("unreachable");
      const [c] = await db
        .insert(schema.campaigns)
        .values({
          playerId,
          title: "flywheel fixture",
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
      await db.insert(schema.players).values({ id: playerId, email: "flywheel@example.com" });
    });

    afterAll(async () => {
      if (!db || !pool) return;
      try {
        for (const id of canonProfileIds) {
          await db.delete(schema.canonChunks).where(eq(schema.canonChunks.profileId, id));
        }
        for (const id of campaignIds) {
          await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
        }
        await db.delete(schema.players).where(eq(schema.players.id, playerId));
      } finally {
        await pool.end();
      }
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockEmbed.mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => [...ONEHOT])),
      );
    });

    // 1 — WORKING: Turn Runtime writes the verbatim episodic tail → the block
    // assembler renders it into Block 3 (§6 layer 1: Working → KA Block 3).
    it(
      "layer 1 WORKING → the exchange surfaces in Block 3 via the block assembler",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        armModels({ prose: "Jet wipes down the galley while the coffee goes cold. " });

        await collectTurn(db, campaignId, "I ask Jet what the bounty board says.");
        const blocks = await assembleForCampaign(db, campaignId);
        if (!blocks) throw new Error("assembly returned null");
        const block3 = blocks.system[2]?.text ?? "";

        expect(block3).toContain("I ask Jet what the bounty board says.");
        expect(block3).toContain("Jet wipes down the galley");
        await settleG2IfPending(db, campaignId);
      },
    );

    // 2 — COMPACTED: the real (subtext-first) compactor writes a narrated beat to
    // Block 2 → loadBeats + the assembler surface it (§6 layer 2: Compacted → KA
    // Block 2). Bulk exchanges are direct inserts; the compaction WRITE is real.
    it(
      "layer 2 COMPACTED → the compactor's beat surfaces in Block 2",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        // 17 verbatim exchanges > the 16-exchange trigger.
        for (let i = 1; i <= 17; i++) {
          await db.insert(schema.episodicRecords).values({
            campaignId,
            turnNumber: i,
            playerInput: `player move ${i}`,
            narration: `narration for turn ${i}`,
            turnId: i,
            provenance: "test_seed",
            confidence: 1,
          });
        }
        const BEAT = "The crew's easy silence hardened into something owed after the Ganymede job.";
        // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic model-call signatures
        mockJudgment.mockImplementation((_s: any, opts: any) => {
          if (opts.name === "compact_beats") return Promise.resolve({ beats: [BEAT] }) as never;
          return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
        });

        const report = await maybeCompact(db, campaignId, 17, SELECTION);
        expect(report.compacted).toBe(true);

        const beats = await loadBeats(db, campaignId);
        expect(beats.some((b) => b.content === BEAT)).toBe(true);
        const blocks = await assembleForCampaign(db, campaignId);
        expect(blocks?.system[1]?.text ?? "").toContain(BEAT);
      },
    );

    // 3 — EPISODIC: Chronicler G1 writes the verbatim record → the recall_scene /
    // get_turn_narrative tools surface it (§6 layer 3: Episodic → recall tools).
    it(
      "layer 3 EPISODIC → recall_scene returns the planted narration",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        armModels({ prose: "Faye counts the cards twice and still comes up short. " });

        await collectTurn(db, campaignId, "I sit down at Faye's poker table.");

        const recalled = await executeRecallScene(db, campaignId, { turn_number: 1 });
        expect(recalled).toContain("Faye counts the cards twice");
        expect(recalled).toContain("I sit down at Faye's poker table.");

        const ranged = await executeGetTurnNarrative(db, campaignId, { from_turn: 1, to_turn: 1 });
        expect(ranged).toContain("Faye counts the cards twice");
        await settleG2IfPending(db, campaignId);
      },
    );

    // 4 — SEMANTIC: G2 distills a fact + embeds it → a LATER turn's retrieval
    // fan-out ranks it into the conte (§6 layer 4: Semantic → tiered retrieval).
    it(
      "layer 4 SEMANTIC → a distilled fact surfaces in a later turn's conte.memories",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        const FACT = "Faye pawned her heirloom pocket-watch on Ganymede to cover a gambling debt.";
        armModels({
          distillFacts: [{ content: FACT, category: "fact", is_plot_critical: false }],
        });

        await collectTurn(db, campaignId, "I search Faye's quarters."); // turn 1 plants
        await collectTurn(db, campaignId, "I ask Faye about the pawn shop."); // turn 2 reads

        const conte2 = await readConte(db, campaignId, 2);
        expect(conte2.memories.some((m) => m.content === FACT)).toBe(true);
        await settleG2IfPending(db, campaignId);
      },
    );

    // 5 — CANON: the SZ research corpus (canon_chunks) → intent-mapped retrieval
    // surfaces it into the conte (§6 layer 5: Canon → Scenewright retrieval).
    it(
      "layer 5 CANON → a corpus chunk surfaces in conte.canon_chunks",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const profileId = `flywheel_canon_${crypto.randomUUID()}`;
        canonProfileIds.push(profileId);
        const CANON =
          "Tharsis dock on Mars: the neon strip where bounty leads and old debts change hands.";
        await db.insert(schema.canonChunks).values({
          profileId,
          pageType: "locations",
          title: "Tharsis dock",
          content: CANON,
          embedding: [...ONEHOT],
          turnId: 0,
          provenance: "sz_research",
          confidence: 1,
        });
        const campaignId = await makeCampaign({
          premiseContract: bebopContract({ anchors_used: [profileId] }),
        });
        armModels({ intent: "EXPLORATION" });

        await collectTurn(db, campaignId, "I wander the Tharsis dock looking for a lead.");

        const conte = await readConte(db, campaignId, 1);
        expect(conte.canon_chunks.some((c) => c.content === CANON)).toBe(true);
        expect(conte.canon_chunks.some((c) => c.source_profile_id === profileId)).toBe(true);
        await settleG2IfPending(db, campaignId);
      },
    );

    // 6 — ENTITY: the KA sidecar admits an NPC to the catalog (G1) → a later turn
    // naming it surfaces the card into the conte (§6 layer 6: Entity → Brief cards).
    it(
      "layer 6 ENTITY → an admitted NPC surfaces in a later turn's conte.entity_cards",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        armModels({
          castDelta: [
            { name: "Vicious", action: "admit_to_catalog", note: "a pale swordsman, an old ghost" },
          ],
        });
        await collectTurn(db, campaignId, "A figure watches from the rafters."); // turn 1 admits

        armModels({}); // turn 2 admits no one
        await collectTurn(db, campaignId, "I go looking for Vicious in the crowd."); // turn 2 names

        const conte2 = await readConte(db, campaignId, 2);
        expect(conte2.entity_cards.some((c) => c.includes("Vicious"))).toBe(true);
        await settleG2IfPending(db, campaignId);
      },
    );

    // 7 — INTENT: a planted seed + a judged consequence (§7.5/§7.6) → a later
    // turn's conte carries the callback AND the active consequence (§6 layer 7).
    it(
      "layer 7 INTENT → seed callback + consequence surface in a later turn's conte",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        const CONSEQUENCE = "The ISSP now has your face on a watchlist at every Gate.";
        const SEED = "the unmarked data-chip Spike pocketed but never opened";

        armModels({ outcomeConsequence: CONSEQUENCE });
        await collectTurn(db, campaignId, "I slip past the ISSP checkpoint."); // turn 1: consequence

        await plantSeed(
          db,
          campaignId,
          1,
          { op: "plant", description: SEED, payoff_window_from: 2, dependencies: [] },
          "test_seed",
        );

        armModels({}); // turn 2 adds no new consequence
        await collectTurn(db, campaignId, "I take stock of what we're carrying.");

        const conte2 = await readConte(db, campaignId, 2);
        expect(conte2.callbacks.some((c) => c.includes(SEED))).toBe(true);
        expect(conte2.active_consequences.some((c) => c.includes(CONSEQUENCE))).toBe(true);
        await settleG2IfPending(db, campaignId);
      },
    );

    // 8 — LEARNED (both reader paths): (a) a G2 pencil mark surfaces in the next
    // turn's Amendments (Renderer reader); (b) a session-close director memo
    // surfaces in the Director cycle's dossier (Director-startup reader).
    it(
      "layer 8 LEARNED → fresh mark rides Amendments AND the memo rides the Director dossier",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");

        // (a) Amendments path — a probe-detected meta-comment becomes a pencil mark.
        const campA = await makeCampaign();
        const MARK = "keep the prose lean and hard-boiled; no purple";
        armModels({ metaComments: [MARK] });
        await collectTurn(db, campA, "meta thought aside, I check the fridge."); // turn 1 writes the mark
        await settleG2IfPending(db, campA); // ensure the mark is written before turn 2 reads it
        await collectTurn(db, campA, "I brew a pot of coffee."); // turn 2 reads it into Amendments
        const conte2 = await readConte(db, campA, 2);
        expect(conte2.charter_amendments).toContain(MARK);
        await settleG2IfPending(db, campA);

        // (b) Dossier path — closeSession writes the memo; runDirectorCycle reads it.
        const campB = await makeCampaign();
        const MEMO = "Carry Forward: the crew still owes the fixer on Europa — do not let it drop.";
        let capturedDossier = "";
        mockStream.mockImplementation(() => plainRound("the next episode teases a debt come due."));
        // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic model-call signatures
        mockJudgment.mockImplementation((_s: any, opts: any) => {
          if (opts.name === "session_memo") return Promise.resolve({ memo: MEMO }) as never;
          if (opts.name === "voice_journal")
            return Promise.resolve({ journal: "clipped, jazz-phrased" }) as never;
          if (String(opts.name).startsWith("director")) {
            capturedDossier = opts.prompt;
            return Promise.reject(new Error("captured-dossier")) as never;
          }
          return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
        });
        await db.insert(schema.sessionRecords).values({
          campaignId: campB,
          sessionNumber: 1,
          turnId: 0,
          provenance: "test_seed",
          confidence: 1,
        });
        await closeSession(db, campB, "explicit"); // writes directorMemo
        await expect(runDirectorCycle(db, campB, 5)).rejects.toThrow(); // reader reached the judgment
        expect(capturedDossier).toContain(MEMO);
      },
    );

    // 9 — CRITICAL: an SZ fact in the Critical layer → guaranteed injection into
    // conte.hard_constraints on EVERY tier, proven on the cheapest douga turn
    // (§6 layer 9: Critical → guaranteed injection every turn).
    it(
      "layer 9 CRITICAL → an sz_fact is injected into a douga turn's hard_constraints",
      { timeout: 60_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const campaignId = await makeCampaign();
        const CRITICAL =
          "Ein the data-dog must never be harmed — the crew would break the world for him.";
        await db.insert(schema.criticalFacts).values({
          campaignId,
          content: CRITICAL,
          category: "sz_fact",
          turnId: 0,
          provenance: "sz_handoff",
          confidence: 1,
        });
        armModels({ intent: "EXPLORATION", epicness: 0.1 }); // → douga tier

        // Turn 1 is the cold open — the C9 opening guard floors it to genga
        // — so the douga probe runs on turn 2.
        await collectTurn(db, campaignId, "I step aboard and take stock.");
        await collectTurn(db, campaignId, "I glance around the quiet hold.");

        const conte = await readConte(db, campaignId, 2);
        expect(conte.tier).toBe("douga");
        expect(conte.hard_constraints.some((c) => c.includes(CRITICAL))).toBe(true);
        await settleG2IfPending(db, campaignId);
      },
    );

    // 10 — PLAYER PROFILE (§6.9): the SZ compiler writes players.profile.taste →
    // the SZ conductor greets a returning player from it. The reader here is the
    // conductor's SYSTEM PROMPT (not conte-level) — asserted via the received
    // streamNarration system blocks.
    it(
      "layer 10 PLAYER PROFILE → taste notes surface in the conductor's returning-player greeting",
      { timeout: 30_000 },
      async () => {
        if (!db) throw new Error("unreachable");
        const TASTE = "always takes the found-family premise";
        await db
          .update(schema.players)
          .set({ profile: { taste: [TASTE, "likes quiet endings that ache"] } })
          .where(eq(schema.players.id, playerId));
        const campaignId = await makeCampaign({ status: "draft" });
        mockStream.mockImplementation(() =>
          plainRound("Pull up a chair — good to see you back at the table."),
        );

        await runConductorTurn(
          db,
          campaignId,
          "I want something with Cowboy Bebop's ache.",
          () => {},
        );

        const sawTaste = mockStream.mock.calls.some((call) => {
          const system = (call[0] as { system?: { text?: string }[] }).system ?? [];
          return system.some((b) => (b.text ?? "").includes(TASTE));
        });
        expect(sawTaste).toBe(true);

        // Reset the shared player's profile so no later suite inherits it.
        await db.update(schema.players).set({ profile: {} }).where(eq(schema.players.id, playerId));
      },
    );
  },
);
