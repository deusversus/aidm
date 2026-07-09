import * as schema from "@/lib/db/schema";
import {
  closeSession,
  openSession,
  rebuildSettei,
  rollingCheckpoint,
} from "@/lib/direction/session";
import { callJudgment, callProbe, prewarmPrefix, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import type { DirectionState } from "@/lib/types/direction";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session lifecycle (§9.4) against real Postgres with scripted models. The
 * Director machinery (director/arcs/seeds) is implemented in parallel, so its
 * frozen signatures are mocked here: startup/review are no-ops we assert are
 * called; getActiveArc/callbackReadySeeds return empty; loadDirectionState /
 * saveDirectionState are backed by an in-memory map (thin; the real ones land
 * with the director agent). Model calls are scripted — NEVER live.
 */

// DirectionState store the mocked director load/save read and write.
const directionStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return {
    ...actual,
    callProbe: vi.fn(),
    callJudgment: vi.fn(),
    streamNarration: vi.fn(),
    prewarmPrefix: vi.fn(),
  };
});
vi.mock("@/lib/direction/director", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/direction/director")>();
  const { DirectionState } = await import("@/lib/types/direction");
  return {
    ...actual,
    loadDirectionState: vi.fn(
      async (_db: unknown, id: string) => directionStore.get(id) ?? DirectionState.parse({}),
    ),
    saveDirectionState: vi.fn(async (_db: unknown, id: string, state: unknown) => {
      directionStore.set(id, state);
    }),
    directorStartup: vi.fn(async () => {}),
    directorReview: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/direction/arcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/direction/arcs")>();
  return { ...actual, getActiveArc: vi.fn(async () => null) };
});
vi.mock("@/lib/direction/seeds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/direction/seeds")>();
  return { ...actual, callbackReadySeeds: vi.fn(async () => []) };
});

import { getActiveArc } from "@/lib/direction/arcs";
import { directorReview, directorStartup } from "@/lib/direction/director";
import { callbackReadySeeds } from "@/lib/direction/seeds";

const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockProbe = vi.mocked(callProbe);
const mockPrewarm = vi.mocked(prewarmPrefix);
const mockStartup = vi.mocked(directorStartup);
const mockReview = vi.mocked(directorReview);
const mockActiveArc = vi.mocked(getActiveArc);
const mockCallbacks = vi.mocked(callbackReadySeeds);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[session] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

/** The { stream, done } shape streamNarration returns; only prose/refused read. */
function narr(prose: string, refused = false) {
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
      refused,
      costUsd: 0,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

function judgmentCount(name: string): number {
  return mockJudgment.mock.calls.filter((c) => (c[1] as { name?: string })?.name === name).length;
}

describe.skipIf(!url)("Session lifecycle (real Postgres, scripted models)", () => {
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
        title: "session fixture",
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

  async function insertSession(
    campaignId: string,
    sessionNumber: number,
    over: Partial<typeof schema.sessionRecords.$inferInsert> = {},
  ) {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.sessionRecords).values({
      campaignId,
      sessionNumber,
      turnId: 0,
      provenance: "test",
      confidence: 1,
      ...over,
    });
  }

  async function insertTurn(campaignId: string, turnNumber: number, fragment?: string) {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber,
      tier: "genga",
      status: "complete",
      playerInput: `input ${turnNumber}`,
      narration: `Narration for turn ${turnNumber}.`,
      completedAt: new Date(),
    });
    await db.insert(schema.episodicRecords).values({
      campaignId,
      turnNumber,
      playerInput: `input ${turnNumber}`,
      narration: `Narration for turn ${turnNumber}.`,
      narratedFragment: fragment,
      turnId: turnNumber,
      provenance: "chronicler_g1",
      confidence: 1,
    });
  }

  function sessionsFor(campaignId: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.sessionRecords)
      .where(eq(schema.sessionRecords.campaignId, campaignId));
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "session@example.com" });
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
    directionStore.clear();
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockStream.mockReset();
    mockPrewarm.mockReset();
    mockPrewarm.mockResolvedValue({ cacheCreation: 0, cacheRead: 0, costUsd: 0 });
    mockStartup.mockClear();
    mockReview.mockClear();
    mockActiveArc.mockReset();
    mockActiveArc.mockResolvedValue(null);
    mockCallbacks.mockReset();
    mockCallbacks.mockResolvedValue([]);
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockJudgment.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "session_memo")
        return Promise.resolve({ memo: "Arc Status: steady.\nCarry Forward: onward." }) as never;
      if (opts.name === "voice_journal")
        return Promise.resolve({ journal: "Your prose stayed clipped and cool." }) as never;
      return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
    });
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockStream.mockImplementation((opts: any) => {
      if (opts.name === "recap") return narr("Previously, the crew chased a ghost across Mars.");
      if (opts.name === "yokoku") return narr("Next time — smoke, and a door left open.");
      throw new Error(`unscripted stream ${opts.name}`);
    });
  });

  // -------------------------------------------------------------------------

  it("first open: pilot true, startup called, no recap, session row 1 with envelope", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();

    const result = await openSession(db, campaignId);

    expect(result.pilot).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.sessionNumber).toBe(1);
    expect(result.recap).toBeUndefined();
    expect(mockStartup).toHaveBeenCalledTimes(1);
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockPrewarm).toHaveBeenCalledTimes(1);

    const rows = await sessionsFor(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionNumber).toBe(1);
    expect(rows[0]?.closedAt).toBeNull();
    expect(rows[0]?.turnId).toBe(0);
    expect(rows[0]?.provenance).toBe("session_lifecycle");
    expect(rows[0]?.confidence).toBe(1);
  });

  it("fresh re-open: opened false, no Director run, no duplicate row", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await openSession(db, campaignId); // creates open row 1 (pilot)
    mockStartup.mockClear();

    const result = await openSession(db, campaignId);

    expect(result.opened).toBe(false);
    expect(result.sessionNumber).toBe(1);
    expect(mockStartup).not.toHaveBeenCalled();
    expect(mockReview).not.toHaveBeenCalled();
    expect(await sessionsFor(campaignId)).toHaveLength(1);
  });

  it("stale open: prior row closed idle_timeout, a fresh row opens", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertSession(campaignId, 1, {
      openedAt: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await openSession(db, campaignId);

    expect(result.opened).toBe(true);
    expect(result.sessionNumber).toBe(2);
    expect(result.pilot).toBe(true); // no turns
    expect(mockStartup).toHaveBeenCalledTimes(1);

    const rows = await sessionsFor(campaignId);
    const prior = rows.find((r) => r.sessionNumber === 1);
    const fresh = rows.find((r) => r.sessionNumber === 2);
    expect(prior?.closedAt).not.toBeNull();
    expect(prior?.closeTrigger).toBe("idle_timeout");
    expect(fresh?.closedAt).toBeNull();
  });

  it("non-pilot open: directorReview runs and the recap is returned", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertTurn(campaignId, 1, "The bounty slipped away again.");

    const result = await openSession(db, campaignId);

    expect(result.pilot).toBe(false);
    expect(result.opened).toBe(true);
    expect(result.recap).toBe("Previously, the crew chased a ghost across Mars.");
    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(mockStartup).not.toHaveBeenCalled();
  });

  it("recap SKIP sentinel → recap undefined (premise declines to recap)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertTurn(campaignId, 1, "A quiet drift through the dark.");
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockStream.mockImplementation((opts: any) =>
      opts.name === "recap" ? narr("SKIP") : narr("(unused)"),
    );

    const result = await openSession(db, campaignId);

    expect(result.opened).toBe(true);
    expect(result.recap).toBeUndefined();
  });

  it("closeSession explicit: memo, voice journal, yokoku persist; yokoku returned", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertTurn(campaignId, 1, "A confession lands.");
    await insertSession(campaignId, 1);

    const result = await closeSession(db, campaignId, "explicit");

    expect(result.yokoku).toBe("Next time — smoke, and a door left open.");
    const [row] = await sessionsFor(campaignId);
    expect(row?.closedAt).not.toBeNull();
    expect(row?.closeTrigger).toBe("explicit");
    expect(row?.directorMemo).toBe("Arc Status: steady.\nCarry Forward: onward.");
    expect(row?.voiceJournal).toBe("Your prose stayed clipped and cool.");
    expect(row?.yokoku).toBe("Next time — smoke, and a door left open.");
  });

  it("closeSession with no open session is a no-op", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();

    const result = await closeSession(db, campaignId, "explicit");

    expect(result.yokoku).toBeUndefined();
    expect(await sessionsFor(campaignId)).toHaveLength(0);
    expect(judgmentCount("session_memo")).toBe(0);
  });

  it("one composer failing does not cost the others", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertTurn(campaignId, 1, "Everyone knew it.");
    await insertSession(campaignId, 1);
    // Memo rejects; journal + yokoku still land.
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockJudgment.mockImplementation((_s: any, opts: any) => {
      if (opts.name === "session_memo")
        return Promise.reject(new Error("scripted memo failure")) as never;
      if (opts.name === "voice_journal")
        return Promise.resolve({ journal: "Held the cool a beat longer." }) as never;
      return Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never;
    });

    const result = await closeSession(db, campaignId, "explicit");

    expect(result.yokoku).toBe("Next time — smoke, and a door left open.");
    const [row] = await sessionsFor(campaignId);
    expect(row?.closedAt).not.toBeNull();
    expect(row?.closeTrigger).toBe("explicit");
    expect(row?.directorMemo).toBeNull(); // the failure
    expect(row?.voiceJournal).toBe("Held the cool a beat longer.");
    expect(row?.yokoku).toBe("Next time — smoke, and a door left open.");
  });

  it("rollingCheckpoint on cadence refreshes the memo in place (stays open)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertSession(campaignId, 1);
    // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
    mockJudgment.mockImplementation((_s: any, opts: any) =>
      opts.name === "session_memo"
        ? (Promise.resolve({ memo: "Checkpoint: threads gathering." }) as never)
        : (Promise.reject(new Error(`unscripted ${opts.name}`)) as never),
    );

    await rollingCheckpoint(db, campaignId, 12);

    const [row] = await sessionsFor(campaignId);
    expect(row?.directorMemo).toBe("Checkpoint: threads gathering.");
    expect(row?.closedAt).toBeNull();
    expect(row?.closeTrigger).toBeNull();
  });

  it("rollingCheckpoint off cadence is a no-op", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await insertSession(campaignId, 1);

    await rollingCheckpoint(db, campaignId, 13);

    const [row] = await sessionsFor(campaignId);
    expect(row?.directorMemo).toBeNull();
    expect(judgmentCount("session_memo")).toBe(0);
  });

  it("rebuildSettei freezes DirectionState.settei with the watermark and bakes marks", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await db.insert(schema.pencilMarks).values({
      campaignId,
      kind: "craft_note",
      topic: "brevity",
      direction: "less flowery please",
      evidence: "the prose ran long in the bar scene",
      turnId: 3,
      provenance: "meta_booth",
      confidence: 0.9,
    });

    await rebuildSettei(db, campaignId, 7);

    const stored = directionStore.get(campaignId) as DirectionState | undefined;
    expect(stored?.settei).toBeDefined();
    expect(stored?.settei?.rebuilt_at_turn).toBe(7);
    expect(stored?.settei?.rebuilt_at).toBeTruthy();
    expect(stored?.settei?.rendered_axes.length).toBeGreaterThan(0);
    expect(stored?.settei?.charter_tokens).toBeGreaterThan(0);
    // The mark's direction rides Block 1's standing calibration (correct
    // DB→PencilMark map: id + provenance present so the row parses).
    expect(stored?.settei?.text).toContain("less flowery please");
  });
});
