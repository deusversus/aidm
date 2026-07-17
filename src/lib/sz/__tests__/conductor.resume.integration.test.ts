import * as schema from "@/lib/db/schema";
import { streamNarration } from "@/lib/llm/calls";
import { researchTitle } from "@/lib/research/research";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ConductorDraft,
  type Observation,
  SZ_KICKOFF,
  draftMessages,
  runConductorTurn,
} from "../conductor";

/**
 * Draft-resume round-trip (M1-C3): the transcript + extraction state
 * rehydrate FROM THE DATABASE between turns — each runConductorTurn call
 * simulates a fresh process. streamNarration is scripted; the DB is real.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, streamNarration: vi.fn() };
});
vi.mock("@/lib/research/research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/research")>();
  return { ...actual, researchTitle: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sz.resume] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** One scripted narration round: emits each text block, then resolves. */
function scriptedRound(blocks: ContentBlock[], stopReason: "end_turn" | "tool_use") {
  return {
    stream: {
      on: (event: string, cb: (t: string) => void) => {
        if (event === "text") {
          for (const b of blocks) if (b.type === "text") cb(b.text);
        }
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

const mockStream = vi.mocked(streamNarration);
const mockResearch = vi.mocked(researchTitle);

const obs = (kind: Observation["kind"], content: string): Observation => ({
  kind,
  content,
  confidence: 0.9,
});

/** The gate's JSON output rode back to the model as this tool_use's tool_result. */
function toolResultFor(draft: ConductorDraft, toolUseId: string): string {
  for (const m of draft.transcript) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; tool_use_id?: string; content?: string }[]) {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) return b.content ?? "";
    }
  }
  throw new Error(`no tool_result for ${toolUseId}`);
}

/** A fully-set table EXCEPT the protagonist's name (the C4 gate's bar; the
 *  SV2 concept is present so the name is the ONLY gap). */
const TABLE_MINUS_NAME: Observation[] = [
  obs("spark", "the moment before the leap, when they go anyway"),
  obs("finitude", "finite — it ends"),
  obs("pc_concept", "the moment-before-the-leap kid — all nerve, no plan, goes anyway"),
  obs("death_physics", "death is real, sudden, cheap"),
  obs("lethality_posture", "a little more intense than default"),
  obs(
    "tier_selection",
    '{"narration":"claude-sonnet-5","judgment":"claude-haiku-4-5","probe":"claude-haiku-4-5"}',
  ),
];

describe.skipIf(!url)("SZ conductor draft-resume (real Postgres, scripted model)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({
      id: playerId,
      email: "resume@example.com",
      profile: { taste: ["loves found-family premises"] },
    });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "Session Zero", status: "draft" })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("turn 1: kickoff persists transcript, observations, and the §6.9 greeting context", async () => {
    if (!db) throw new Error("unreachable");
    mockStream
      .mockReturnValueOnce(
        scriptedRound(
          [
            { type: "text", text: "Welcome back. " },
            {
              type: "tool_use",
              id: "tu_1",
              name: "record_observation",
              input: { kind: "player_taste", content: "returning player, greeted warmly" },
            },
          ],
          "tool_use",
        ),
      )
      .mockReturnValueOnce(
        scriptedRound([{ type: "text", text: "So — what are we playing?" }], "end_turn"),
      );

    const texts: string[] = [];
    const draft = await runConductorTurn(db, campaignId, "", (e) => {
      if (e.type === "text" && e.text) texts.push(e.text);
    });

    expect(texts.join("")).toContain("what are we playing");
    expect(draft.observations).toHaveLength(1);
    // Kickoff sentinel + assistant(tool) + tool_result + assistant(final).
    expect(draft.transcript).toHaveLength(4);
    expect(draft.transcript[0]?.content).toBe(SZ_KICKOFF);

    // The §6.9 returning-player block rode along in the system array — and
    // carries the posture: taste is recognition material, never a default for
    // the new campaign (§0 authority ordering; user-named 2026-07-12).
    const call = mockStream.mock.calls[0]?.[0];
    const tasteBlock = call?.system.find((b) => b.text.includes("found-family"));
    expect(tasteBlock).toBeDefined();
    expect(tasteBlock?.text).toContain("Recognition, never presumption");

    // Persisted, not just in memory.
    const [row] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect((row?.szTranscript as ConductorDraft).transcript).toHaveLength(4);
    expect(row?.szExtraction).toHaveLength(1);
  });

  it("turn 2 resumes from the DB: full history reaches the model, conversation continues", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    mockStream.mockReturnValueOnce(
      scriptedRound(
        [{ type: "text", text: "Bebop it is. Tell me a moment you want more of." }],
        "end_turn",
      ),
    );

    // A fresh call — state must come from Postgres, not from turn 1's closure.
    const draft = await runConductorTurn(db, campaignId, "let's play cowboy bebop", () => {});

    const sent = mockStream.mock.calls[0]?.[0];
    expect(sent?.messages).toHaveLength(5); // turn 1's four + the new player message
    expect(sent?.messages[0]?.content).toBe(SZ_KICKOFF);
    expect(sent?.messages[4]?.content).toBe("let's play cowboy bebop");
    // Tool round-trips survive rehydration in order (API replay requirement).
    const blocks = sent?.messages[1]?.content as { type: string }[];
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);

    expect(draft.transcript).toHaveLength(6);
    // Extraction state rehydrates too: turn 1's observation came from the DB,
    // not this turn's memory, and survives the round-trip.
    expect(draft.observations).toHaveLength(1);
    expect(draft.observations[0]?.content).toContain("returning player");
    const [row] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(row?.szExtraction).toHaveLength(1);
    const shown = draftMessages(draft);
    expect(shown.some((m) => m.role === "player" && m.text.includes("cowboy bebop"))).toBe(true);
    expect(shown.some((m) => m.text === SZ_KICKOFF)).toBe(false);
  });

  it("propose_contract gate (M2 C4): an unnamed table returns {ready:false} with the PC gap, readyToCompile stays false", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    const draft: ConductorDraft = {
      transcript: [],
      observations: TABLE_MINUS_NAME,
      profileIds: ["seeded-profile"], // gate reads only the boolean, not the row
      readyToCompile: false,
    };
    const [c] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "gate unnamed", status: "draft", szTranscript: draft })
      .returning();
    if (!c) throw new Error("insert failed");
    try {
      mockStream
        .mockReturnValueOnce(
          scriptedRound(
            [
              {
                type: "tool_use",
                id: "pc_1",
                name: "propose_contract",
                input: { campaign_title: "Untitled" },
              },
            ],
            "tool_use",
          ),
        )
        .mockReturnValueOnce(
          scriptedRound([{ type: "text", text: "One thing left — who are they?" }], "end_turn"),
        );
      const result = await runConductorTurn(db, c.id, "I think we're ready", () => {});
      expect(result.readyToCompile).toBe(false);
      const parsed = JSON.parse(toolResultFor(result, "pc_1"));
      expect(parsed.ready).toBe(false);
      expect(parsed.gaps.some((g: string) => g.includes("protagonist is unnamed"))).toBe(true);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
    }
  });

  it("research_title's tool result carries the profile's power_distribution (SV3 baseline plumbing)", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    // The POWER TIER beat instructs the model to use the research result's
    // typical_tier as the baseline — this pins that the field actually
    // ARRIVES (it nests under ip_mechanics in the stored Profile; a
    // top-level read silently drops it, audit-verify catch 2026-07-12).
    const profileId = `test_power_profile_${crypto.randomUUID()}`;
    await db.insert(schema.profiles).values({
      id: profileId,
      title: "Cowboy Bebop",
      profile: {
        ip_mechanics: {
          power_distribution: {
            peak_tier: "T6",
            typical_tier: "T9",
            floor_tier: "T10",
            gradient: "flat",
          },
        },
      },
    });
    mockResearch.mockResolvedValue({
      profileId,
      title: "Cowboy Bebop",
      scope: "standard",
      seasonsMerged: 1,
      wikiBase: null,
      pagesFetched: 3,
      chunksWritten: 0,
      confidence: 90,
      notes: [],
    });
    const [c] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "research plumb", status: "draft" })
      .returning();
    if (!c) throw new Error("insert failed");
    try {
      mockStream
        .mockReturnValueOnce(
          scriptedRound(
            [
              {
                type: "tool_use",
                id: "rt_1",
                name: "research_title",
                input: { title: "Cowboy Bebop" },
              },
            ],
            "tool_use",
          ),
        )
        .mockReturnValueOnce(
          scriptedRound([{ type: "text", text: "Bebop's loaded — T9 world." }], "end_turn"),
        );
      const result = await runConductorTurn(db, c.id, "let's play cowboy bebop", () => {});
      const parsed = JSON.parse(toolResultFor(result, "rt_1"));
      expect(parsed.verified).toBe(true);
      expect(parsed.power_distribution?.typical_tier).toBe("T9");
      expect(parsed.power_distribution?.peak_tier).toBe("T6");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, profileId));
    }
  });

  it("propose_contract gate (SV2): a conceptless table returns {ready:false} with the concept gap", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    const draft: ConductorDraft = {
      transcript: [],
      observations: [
        ...TABLE_MINUS_NAME.filter((o) => o.kind !== "pc_concept"),
        obs("pc_name", "Kaelen — he chose it himself"),
      ],
      profileIds: ["seeded-profile"],
      readyToCompile: false,
    };
    const [c] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "gate conceptless", status: "draft", szTranscript: draft })
      .returning();
    if (!c) throw new Error("insert failed");
    try {
      mockStream
        .mockReturnValueOnce(
          scriptedRound(
            [
              {
                type: "tool_use",
                id: "pc_1",
                name: "propose_contract",
                input: { campaign_title: "Untitled" },
              },
            ],
            "tool_use",
          ),
        )
        .mockReturnValueOnce(
          scriptedRound([{ type: "text", text: "So — who ARE they in this?" }], "end_turn"),
        );
      const result = await runConductorTurn(db, c.id, "ready when you are", () => {});
      expect(result.readyToCompile).toBe(false);
      const parsed = JSON.parse(toolResultFor(result, "pc_1"));
      expect(parsed.ready).toBe(false);
      expect(parsed.gaps.some((g: string) => g.includes("concept was never gathered"))).toBe(true);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
    }
  });

  it("propose_contract gate (M2 C4): a named table with a deferral elsewhere returns {ready:true} carrying the open item", async () => {
    if (!db) throw new Error("unreachable");
    mockStream.mockReset();
    const draft: ConductorDraft = {
      transcript: [],
      observations: [
        ...TABLE_MINUS_NAME,
        obs("pc_name", "Kaelen — he chose it himself"),
        obs("deferred", "who the recurring antagonist is — director's territory"),
      ],
      profileIds: ["seeded-profile"],
      readyToCompile: false,
    };
    const [c] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "gate named", status: "draft", szTranscript: draft })
      .returning();
    if (!c) throw new Error("insert failed");
    try {
      mockStream
        .mockReturnValueOnce(
          scriptedRound(
            [
              {
                type: "tool_use",
                id: "pc_1",
                name: "propose_contract",
                input: { campaign_title: "The Long Quiet" },
              },
            ],
            "tool_use",
          ),
        )
        .mockReturnValueOnce(
          scriptedRound(
            [{ type: "text", text: "The table's set. Here's what we've got…" }],
            "end_turn",
          ),
        );
      const result = await runConductorTurn(db, c.id, "okay, we're set", () => {});
      expect(result.readyToCompile).toBe(true);
      const parsed = JSON.parse(toolResultFor(result, "pc_1"));
      expect(parsed.ready).toBe(true);
      expect(parsed.open_items.some((o: string) => o.includes("recurring antagonist"))).toBe(true);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
    }
  });
});
