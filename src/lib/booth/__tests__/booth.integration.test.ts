import { assembleForCampaign } from "@/lib/blocks/campaign";
import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { BoothState } from "@/lib/types/booth";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTH_PROVENANCE, closeBoothIfOpen, mintOverride, runBoothExchange } from "../booth";

/**
 * The meta booth + override channel (§5.4, §7.4; C9) against real Postgres
 * with scripted models. The router (callProbe), the responder
 * (streamNarration), and the resolution extractor (callJudgment) are mocked;
 * the block prefix (assembleForCampaign) is mocked to a fixed system array so
 * the "reuse the cached blocks 1–3 prefix" mandate is asserted directly.
 * Model calls are NEVER live.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return {
    ...actual,
    callProbe: vi.fn(),
    callJudgment: vi.fn(),
    streamNarration: vi.fn(),
  };
});
vi.mock("@/lib/blocks/campaign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blocks/campaign")>();
  return { ...actual, assembleForCampaign: vi.fn() };
});

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockAssemble = vi.mocked(assembleForCampaign);

/** The blocks 1–3 prefix the responder must reuse verbatim (§5.4 cache mandate). */
const BLOCKS = { system: [{ type: "text" as const, text: "BLOCK1" }] };

/** The { stream, done } shape streamNarration returns; only prose is read by the booth. */
function narr(prose: string) {
  return {
    stream: { on: () => {} },
    done: async () => ({
      message: {
        content: [{ type: "text", text: prose }],
        stop_reason: "end_turn",
        model: "scripted",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      prose,
      sidecar: null,
      fallbackUsed: false,
      refused: false,
      costUsd: 0,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

const url = process.env.DATABASE_URL;
if (!url) console.warn("[booth] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

interface SeedExchange {
  role: "player" | "studio";
  text: string;
  responder?: "director" | "ka";
  at_turn: number;
}

describe.skipIf(!url)("Meta booth + override channel (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "booth fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  async function setBoothState(
    campaignId: string,
    openedAtTurn: number,
    exchanges: SeedExchange[],
  ) {
    if (!db) throw new Error("unreachable");
    await db
      .update(schema.campaigns)
      .set({ boothState: { opened_at_turn: openedAtTurn, exchanges } })
      .where(eq(schema.campaigns.id, campaignId));
  }

  async function readBoothState(campaignId: string): Promise<unknown> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .select({ b: schema.campaigns.boothState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    return row?.b ?? null;
  }

  function marksFor(campaignId: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.pencilMarks)
      .where(eq(schema.pencilMarks.campaignId, campaignId));
  }

  function overridesFor(campaignId: string) {
    if (!db) throw new Error("unreachable");
    return db.select().from(schema.overrides).where(eq(schema.overrides.campaignId, campaignId));
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "booth@example.com" });
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
    mockAssemble.mockReset();
    mockAssemble.mockResolvedValue(BLOCKS as never);
    mockProbe.mockResolvedValue({ responder: "director", reason: "default" } as never);
    mockJudgment.mockResolvedValue({
      marks: [],
      overrides: [],
      summary: "nothing settled",
    } as never);
    mockStream.mockImplementation(() => narr("Noted."));
  });

  // -------------------------------------------------------------------------

  it("router single-responder: a craft question routes to the director; streamNarration fires once", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockProbe.mockResolvedValue({ responder: "director", reason: "craft" } as never);
    mockStream.mockImplementation(() => narr("Here's what I had in mind for the arc."));

    const res = await runBoothExchange(db, campaignId, 3, "Is the arc pacing dragging?", () => {});

    expect(res.responder).toBe("director");
    expect(res.closed).toBe(false);
    expect(res.reply).toBe("Here's what I had in mind for the arc.");
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("router single-responder: a prose question routes to the ka; streamNarration fires once", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockProbe.mockResolvedValue({ responder: "ka", reason: "prose" } as never);
    mockStream.mockImplementation(() => narr("I leaned clipped on purpose."));

    const res = await runBoothExchange(
      db,
      campaignId,
      3,
      "Why is the prose so terse lately?",
      () => {},
    );

    expect(res.responder).toBe("ka");
    expect(res.closed).toBe(false);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("explicit summon wins: the router receives the summon and its verdict is honored", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    // Scripted: the router honored the in-words summon over topic classification.
    mockProbe.mockResolvedValue({
      responder: "ka",
      reason: "explicit summon: 'let me talk to the writer'",
    } as never);

    const res = await runBoothExchange(
      db,
      campaignId,
      3,
      "Let me talk to the writer about that last scene.",
      () => {},
    );

    expect(res.responder).toBe("ka");
    const routerOpts = mockProbe.mock.calls[0]?.[1] as { prompt: string } | undefined;
    expect(routerOpts?.prompt).toContain("talk to the writer");
  });

  it("transcript persistence: two exchanges grow booth_state to 4 entries; opened_at_turn stamps once", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockProbe.mockResolvedValue({ responder: "director", reason: "x" } as never);
    mockStream.mockImplementation(() => narr("Reply."));

    await runBoothExchange(db, campaignId, 4, "First question.", () => {});
    await runBoothExchange(db, campaignId, 6, "Second question.", () => {});

    const state = BoothState.parse((await readBoothState(campaignId)) ?? {});
    expect(state.exchanges).toHaveLength(4);
    expect(state.opened_at_turn).toBe(4); // stamped on the first exchange, unchanged since
    expect(state.exchanges[0]?.role).toBe("player");
    expect(state.exchanges[0]?.text).toBe("First question.");
    expect(state.exchanges[1]?.role).toBe("studio");
    expect(state.exchanges[1]?.responder).toBe("director");
    expect(state.exchanges[2]?.text).toBe("Second question.");
  });

  it("cap: the 12th exchange closes the booth, carries the resolution instruction, clears state, writes calibrations", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    // Seed 11 prior player exchanges (11 pairs) — the incoming one is #12 = cap.
    const seeded: SeedExchange[] = [];
    for (let i = 1; i <= 11; i++) {
      seeded.push({ role: "player", text: `q${i}`, at_turn: i });
      seeded.push({ role: "studio", text: `a${i}`, responder: "director", at_turn: i });
    }
    await setBoothState(campaignId, 1, seeded);

    mockProbe.mockResolvedValue({ responder: "director", reason: "x" } as never);
    mockStream.mockImplementation(() => narr("Here's the wrap-up of what we decided."));
    mockJudgment.mockResolvedValue({
      marks: [
        {
          kind: "craft_note",
          topic: "brevity",
          direction: "keep the bar scenes tight",
          evidence: "player said less flowery",
        },
      ],
      overrides: ["never kill the dog"],
      summary: "Tightened bar scenes; the dog is safe.",
    } as never);

    const res = await runBoothExchange(
      db,
      campaignId,
      12,
      "One more thought before we wrap.",
      () => {},
    );

    expect(res.closed).toBe(true);
    expect(res.summary).toBe("Here's the wrap-up of what we decided.");

    const streamOpts = mockStream.mock.calls[0]?.[0] as { messages: { content: string }[] };
    expect(streamOpts.messages[0]?.content).toContain("final exchange");

    expect(await readBoothState(campaignId)).toBeNull();

    const marks = await marksFor(campaignId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.provenance).toBe(BOOTH_PROVENANCE);
    expect(marks[0]?.turnId).toBe(12);

    const ovs = await overridesFor(campaignId);
    expect(ovs).toHaveLength(1);
    expect(ovs[0]?.provenance).toBe(BOOTH_PROVENANCE);
    expect(ovs[0]?.content).toBe("never kill the dog");
  });

  it("closeBoothIfOpen is a no-op on an empty booth: no judgment, no writes", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();

    await closeBoothIfOpen(db, campaignId, 5);

    expect(mockJudgment).not.toHaveBeenCalled();
    expect(await marksFor(campaignId)).toHaveLength(0);
    expect(await overridesFor(campaignId)).toHaveLength(0);
  });

  it("closeBoothIfOpen extraction writes marks (meta_booth) + override rows, then clears state", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await setBoothState(campaignId, 2, [
      { role: "player", text: "make it darker", at_turn: 2 },
      { role: "studio", text: "noted", responder: "director", at_turn: 2 },
    ]);
    mockJudgment.mockResolvedValue({
      marks: [
        {
          kind: "axis",
          topic: "darkness",
          direction: "run darker than canon",
          evidence: "make it darker",
        },
      ],
      overrides: ["no comic relief in finales"],
      summary: "Darker tone; no comedy in finales.",
    } as never);

    await closeBoothIfOpen(db, campaignId, 8);

    const marks = await marksFor(campaignId);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.kind).toBe("axis");
    expect(marks[0]?.provenance).toBe(BOOTH_PROVENANCE);
    expect(marks[0]?.turnId).toBe(8);
    expect(Number(marks[0]?.confidence)).toBeCloseTo(0.9);

    const ovs = await overridesFor(campaignId);
    expect(ovs).toHaveLength(1);
    expect(ovs[0]?.provenance).toBe(BOOTH_PROVENANCE);
    expect(ovs[0]?.active).toBe(true);
    expect(Number(ovs[0]?.confidence)).toBeCloseTo(1);

    expect(await readBoothState(campaignId)).toBeNull();
  });

  it("closeBoothIfOpen clears the booth even when extraction fails (lost calibration, never a wedged turn)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await setBoothState(campaignId, 2, [
      { role: "player", text: "x", at_turn: 2 },
      { role: "studio", text: "y", responder: "ka", at_turn: 2 },
    ]);
    mockJudgment.mockRejectedValue(new Error("scripted extraction failure"));

    await closeBoothIfOpen(db, campaignId, 9);

    expect(await marksFor(campaignId)).toHaveLength(0);
    expect(await readBoothState(campaignId)).toBeNull();
  });

  it("mintOverride writes an active player_override row and returns the acknowledgement — no model call", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();

    const res = await mintOverride(db, campaignId, 7, "Kaori never dies");

    expect(res.acknowledgement).toContain("Standing rule recorded");
    expect(res.acknowledgement).toContain("Kaori never dies");

    const ovs = await overridesFor(campaignId);
    expect(ovs).toHaveLength(1);
    expect(ovs[0]?.content).toBe("Kaori never dies");
    expect(ovs[0]?.active).toBe(true);
    expect(ovs[0]?.provenance).toBe("player_override");
    expect(ovs[0]?.turnId).toBe(7);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockJudgment).not.toHaveBeenCalled();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("booth-cache prefix reuse: the responder receives the assembled blocks system array verbatim", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockProbe.mockResolvedValue({ responder: "director", reason: "x" } as never);
    mockStream.mockImplementation(() => narr("Noted."));

    await runBoothExchange(db, campaignId, 3, "A craft question about the arc.", () => {});

    expect(mockStream).toHaveBeenCalledTimes(1);
    const streamOpts = mockStream.mock.calls[0]?.[0] as { system: unknown };
    // toBe: the exact reference from assembleForCampaign flows through untouched.
    expect(streamOpts.system).toBe(BLOCKS.system);
    expect(streamOpts.system).toEqual([{ type: "text", text: "BLOCK1" }]);
  });

  it("same-turn replay returns the persisted reply without re-running the responder (§5.7)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await setBoothState(campaignId, 3, [
      { role: "player", text: "meta: pacing?", at_turn: 3 },
      { role: "studio", text: "Already answered this.", responder: "ka", at_turn: 3 },
    ]);
    const emitted: string[] = [];

    const res = await runBoothExchange(db, campaignId, 3, "meta: pacing?", (t) => emitted.push(t));

    expect(res.reply).toBe("Already answered this.");
    expect(res.responder).toBe("ka");
    expect(emitted.join("")).toBe("Already answered this.");
    // No re-billing, no duplicated pair (C9 audit: crash-replay idempotency).
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    const state = (await readBoothState(campaignId)) as { exchanges: unknown[] };
    expect(state.exchanges).toHaveLength(2);
  });

  it("a refused or empty responder reply throws — never persisted as a hollow exchange", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockStream.mockImplementation(
      () =>
        ({
          stream: { on: () => {} },
          done: async () => ({
            message: { content: [], stop_reason: "refusal" },
            prose: "",
            sidecar: null,
            fallbackUsed: false,
            refused: true,
            costUsd: 0,
          }),
        }) as never,
    );
    await expect(runBoothExchange(db, campaignId, 1, "meta: hm", () => {})).rejects.toThrow(
      /refused/,
    );
    expect(await readBoothState(campaignId)).toBeNull();
  });

  it("mintOverride is idempotent per turn: a crash-replay re-acknowledges without duplicating the rule", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const first = await mintOverride(db, campaignId, 4, "never harm the dog");
    const second = await mintOverride(db, campaignId, 4, "never harm the dog");
    expect(second.acknowledgement).toBe(first.acknowledgement);
    const rows = await overridesFor(campaignId);
    expect(rows).toHaveLength(1);
  });

  it("router failure defaults to the director — the booth never blocks", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    mockProbe.mockRejectedValue(new Error("router down"));
    mockStream.mockImplementation(() => narr("Director speaking."));

    const res = await runBoothExchange(db, campaignId, 3, "anything at all", () => {});

    expect(res.responder).toBe("director");
    expect(res.closed).toBe(false);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
