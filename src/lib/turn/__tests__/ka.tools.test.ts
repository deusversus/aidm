import type { Db } from "@/lib/db";
import { callProbe, streamNarration } from "@/lib/llm/calls";
import { Conte } from "@/lib/types/conte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_REFUSAL, runKeyAnimator } from "../ka";
import { KA_TOOLS, executeGetTurnNarrative, executeRecallScene, executeSearchLore } from "../tools";

/**
 * The tool law (M2R5 C1). Tools render ahead of `system` in the cache key, so
 * the KA's array must be identical on every call regardless of tier or ladder
 * step — a douga beat between two genga turns used to bust all three block
 * breakpoints twice. The research budget now lives entirely in the loop: an
 * over-budget call gets a refusal tool_result, never execution.
 *
 * Hermetic: streamNarration and the research executors are scripted, so no
 * model and no Postgres are touched.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, streamNarration: vi.fn(), callProbe: vi.fn() };
});
vi.mock("../tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools")>();
  return {
    ...actual,
    executeSearchLore: vi.fn(async () => "lore"),
    executeRecallScene: vi.fn(async () => "recalled"),
    executeGetTurnNarrative: vi.fn(async () => "narrative"),
  };
});

const mockStream = vi.mocked(streamNarration);
const mockProbe = vi.mocked(callProbe);

const SIDECAR = {
  scene_cast_delta: [],
  decision_point: false,
  intended_seed_mentions: [],
  notable_beats: ["the hatch was already open"],
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function kaRound(blocks: Block[], stopReason: string) {
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

const commitBlock = (id: string): Block => ({
  type: "tool_use",
  id,
  name: "commit_scene",
  input: SIDECAR,
});
const researchBlock = (id: string): Block => ({
  type: "tool_use",
  id,
  name: "recall_scene",
  input: { turn_number: 1 },
});

type KAArgs = Parameters<typeof runKeyAnimator>[1];

function kaArgs(over: Partial<KAArgs> = {}): KAArgs {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    turnNumber: 7,
    conte: Conte.parse({ turn_id: 7, tier: "genga" }),
    playerInput: "I wait by the door",
    exchangeMessages: [],
    system: [{ type: "text", text: "settei" }],
    selection: {
      narration: "claude-sonnet-5",
      judgment: "claude-sonnet-5",
      probe: "claude-haiku-4-5",
    },
    effort: "high",
    maxTokens: 1_000,
    kaResearchCalls: 2,
    ladderSteps: [],
    profileIds: [],
    emit: () => {},
    ...over,
  };
}

const noDb = {} as Db;

beforeEach(() => {
  mockStream.mockReset();
  mockProbe.mockReset();
  vi.mocked(executeSearchLore).mockClear();
  vi.mocked(executeRecallScene).mockClear();
  vi.mocked(executeGetTurnNarrative).mockClear();
});

describe("the KA tool array is constant (M2R5 C1)", () => {
  it("douga, genga, and cap_research_0-degraded turns send byte-identical tools", async () => {
    mockStream.mockImplementation(() =>
      kaRound([{ type: "text", text: "A scene. " }, commitBlock("t1")], "tool_use"),
    );

    // douga: no research allowance at all.
    await runKeyAnimator(
      noDb,
      kaArgs({ conte: Conte.parse({ turn_id: 1, tier: "douga" }), kaResearchCalls: 0 }),
    );
    // genga: the default two.
    await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 2 }));
    // sakuga degraded to zero by the ladder — the array must not shrink.
    await runKeyAnimator(
      noDb,
      kaArgs({
        conte: Conte.parse({ turn_id: 9, tier: "sakuga", degraded: true }),
        kaResearchCalls: 4,
        ladderSteps: ["cap_research_2", "cap_research_0"],
      }),
    );

    const sent = mockStream.mock.calls.map((c) => c[0].tools);
    expect(sent).toHaveLength(3);
    const serialized = sent.map((t) => JSON.stringify(t));
    expect(new Set(serialized).size).toBe(1);
    expect(serialized[0]).toBe(JSON.stringify(KA_TOOLS));
  });

  it("the storyboard carries the allowance the tool array no longer can", async () => {
    mockStream.mockImplementation(() =>
      kaRound([{ type: "text", text: "A scene. " }, commitBlock("t1")], "tool_use"),
    );
    await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 0 }));
    await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 2 }));

    const zero = JSON.stringify(mockStream.mock.calls[0]?.[0].messages);
    const two = JSON.stringify(mockStream.mock.calls[1]?.[0].messages);
    expect(zero).toContain("Research allowance this scene: NONE");
    expect(two).toContain("Research allowance this scene: 2 tool call(s)");
  });

  it("the trailer leads the array and the research tools follow, in a fixed order", () => {
    expect(KA_TOOLS.map((t) => t.name)).toEqual([
      "commit_scene",
      "search_lore",
      "recall_scene",
      "get_turn_narrative",
    ]);
  });
});

describe("the research budget is enforced in the loop, not in the tool array", () => {
  it("an over-budget research call gets the refusal — no executor, no counter bump, scene still commits", async () => {
    let round = 0;
    mockStream.mockImplementation(() => {
      round += 1;
      if (round === 1) return kaRound([researchBlock("r1")], "tool_use");
      return kaRound(
        [{ type: "text", text: "Written from what I hold. " }, commitBlock("t2")],
        "tool_use",
      );
    });

    const result = await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 0 }));

    expect(vi.mocked(executeRecallScene)).not.toHaveBeenCalled();
    expect(vi.mocked(executeSearchLore)).not.toHaveBeenCalled();
    expect(vi.mocked(executeGetTurnNarrative)).not.toHaveBeenCalled();
    expect(result.researchCalls).toBe(0);
    expect(result.sidecar).not.toBeNull();
    expect(result.trailerFallback).toBe(false);

    // The refused call was answered — a dangling tool_use would 400 the next
    // request — and the second round still carries the same tool array.
    const second = mockStream.mock.calls[1]?.[0];
    expect(JSON.stringify(second?.messages)).toContain(RESEARCH_REFUSAL);
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(KA_TOOLS));
  });

  it("a stubborn model cannot spin: refused rounds still count against the loop cap", async () => {
    mockStream.mockImplementation(() => kaRound([researchBlock("r")], "tool_use"));
    mockProbe.mockResolvedValue(SIDECAR as never);

    const result = await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 0 }));

    // budget 0 → cap of two SCENE rounds. The third call is the §5.7 trailer
    // continuation (M3 C1), which is bounded at exactly one and cannot ask for
    // research — tool_choice forces commit_scene — so the cap still holds.
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(mockStream.mock.calls[2]?.[0].toolChoice).toEqual({
      type: "tool",
      name: "commit_scene",
    });
    expect(result.researchCalls).toBe(0);
    expect(result.trailerFallback).toBe(true);
    expect(vi.mocked(executeRecallScene)).not.toHaveBeenCalled();
  });

  it("a within-budget research call still executes", async () => {
    let round = 0;
    mockStream.mockImplementation(() => {
      round += 1;
      if (round === 1) return kaRound([researchBlock("r1")], "tool_use");
      return kaRound([{ type: "text", text: "Researched. " }, commitBlock("t2")], "tool_use");
    });

    const result = await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 2 }));

    expect(vi.mocked(executeRecallScene)).toHaveBeenCalledTimes(1);
    expect(result.researchCalls).toBe(1);
    expect(JSON.stringify(mockStream.mock.calls[1]?.[0].messages)).not.toContain(RESEARCH_REFUSAL);
  });
});

describe("the pen's own hand reaches the wire (M3R2 C2)", () => {
  it("prior exchanges thread ahead of the conte as real turns", async () => {
    mockStream.mockImplementation(() =>
      kaRound(
        [
          { type: "text", text: "ok " },
          { type: "tool_use", id: "t1", name: "commit_scene", input: SIDECAR },
        ],
        "tool_use",
      ),
    );
    await runKeyAnimator(
      noDb,
      kaArgs({
        kaResearchCalls: 0,
        exchangeMessages: [
          { role: "user", content: [{ type: "text", text: "[Turn 1]\ngo" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "The prior scene, in the writer's own hand." }],
          },
        ],
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: mock harness
    const call = mockStream.mock.calls[0]?.[0] as any;
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0].role).toBe("user");
    expect(call.messages[1].role).toBe("assistant");
    expect(
      Array.isArray(call.messages[1].content) ? call.messages[1].content[0]?.text : "",
    ).toContain("the writer's own hand");
    expect(call.messages[2].role).toBe("user"); // the conte closes the thread
  });
});
