import type { Db } from "@/lib/db";
import { callProbe, streamNarration } from "@/lib/llm/calls";
import { Conte } from "@/lib/types/conte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRAILER_DEMAND, runKeyAnimator } from "../ka";
import { KA_TOOLS } from "../tools";

/**
 * The §5.7 trailer ladder (M3 C1). Measured 2026-08-01: the native trailer
 * landed on 0 of 15 live turns — every scene ended `end_turn` with finished
 * prose and no tool_use at all — so every sidecar came from a probe reading
 * the prose back, and one of those reconstructions filed a living character
 * as a dead one. The ladder is now native → continuation → probe: ask the
 * writer again before asking a stranger.
 *
 * Hermetic: streamNarration and callProbe are scripted per round; no model,
 * no Postgres.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, streamNarration: vi.fn(), callProbe: vi.fn() };
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
      costUsd: 0.01,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

const commitBlock = (id: string, input: unknown = SIDECAR): Block => ({
  type: "tool_use",
  id,
  name: "commit_scene",
  input,
});

type KAArgs = Parameters<typeof runKeyAnimator>[1];

function kaArgs(over: Partial<KAArgs> = {}): KAArgs {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    turnNumber: 7,
    conte: Conte.parse({ turn_id: 7, tier: "genga" }),
    playerInput: "I wait by the door",
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

/** The scene as production actually produces it: prose, then a stopped turn. */
const proseOnly = () => kaRound([{ type: "text", text: "The tray went up at 20:11." }], "end_turn");

beforeEach(() => {
  mockStream.mockReset();
  mockProbe.mockReset();
});

describe("the trailer ladder (§5.7)", () => {
  it("native trailer: one round, no continuation, no probe", async () => {
    mockStream.mockImplementation(() =>
      kaRound([{ type: "text", text: "A scene. " }, commitBlock("t1")], "tool_use"),
    );

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(result.trailerSource).toBe("native");
    expect(result.trailerFallback).toBe(false);
    expect(result.sidecar).toEqual(SIDECAR);
  });

  it("missing trailer: ONE continuation round recovers it — the probe never runs", async () => {
    let round = 0;
    mockStream.mockImplementation(() => {
      round += 1;
      return round === 1 ? proseOnly() : kaRound([commitBlock("t2")], "tool_use");
    });

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(result.trailerSource).toBe("continuation");
    // The native trailer WAS missing — the checkpoint still says so.
    expect(result.trailerFallback).toBe(true);
    expect(result.sidecar).toEqual(SIDECAR);
    // The scene's prose is untouched by the extra round.
    expect(result.prose).toBe("The tray went up at 20:11.");
    // Both rounds bill.
    expect(result.costUsd).toBeCloseTo(0.02);
  });

  it("the continuation replays the scene and demands only the trailer", async () => {
    let round = 0;
    // ka mutates ONE messages array across rounds — mock.calls holds live
    // references that show final state, not the payload each round SAW.
    // Snapshot at call time (C1 audit).
    const sent: unknown[][] = [];
    mockStream.mockImplementation((opts: { messages: unknown[] }) => {
      sent.push(JSON.parse(JSON.stringify(opts.messages)));
      round += 1;
      return round === 1 ? proseOnly() : kaRound([commitBlock("t2")], "tool_use");
    });

    await runKeyAnimator(noDb, kaArgs());

    const second = mockStream.mock.calls[1]?.[0];
    const secondPayload = sent[1] as { role: string; content: unknown }[];
    // Same conversation: the storyboard, the scene, then the ask — so the
    // whole cached prefix is warm and the model still has the scene in view.
    expect(secondPayload).toHaveLength(3);
    expect(secondPayload[1]?.role).toBe("assistant");
    expect(secondPayload[2]?.role).toBe("user");
    expect(secondPayload[2]?.content).toBe(TRAILER_DEMAND);
    // No prose is wanted, so the trailer is demanded outright.
    expect(second?.toolChoice).toEqual({ type: "tool", name: "commit_scene" });
    // The tool array and the effort stay the KA's — both ride the cache key.
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(KA_TOOLS));
    expect(second?.effort).toBe("high");
    expect(JSON.stringify(second?.system)).toBe(JSON.stringify(kaArgs().system));
  });

  it("cap exhaustion: the continuation never replays an already-answered turn", async () => {
    // Budget 0 (douga shape): every research ask is refused in-loop, the
    // assistant turn + its tool_results are ALREADY in the conversation when
    // the round cap exhausts. The continuation must add ONLY the demand —
    // re-pushing the turn duplicates tool_use ids and the API 400s, killing
    // the feature on exactly the sakuga turns that spend their full budget
    // (C1 audit MUST-FIX; this was the one uncovered exit path).
    const research = (id: string): Block => ({
      type: "tool_use",
      id,
      name: "search_lore",
      input: { query: "the hatch" },
    });
    let round = 0;
    const sent: unknown[][] = [];
    mockStream.mockImplementation((opts: { messages: unknown[] }) => {
      sent.push(JSON.parse(JSON.stringify(opts.messages)));
      round += 1;
      if (round <= 2)
        return kaRound(
          [{ type: "text", text: `beat ${round}. ` }, research(`r${round}`)],
          "tool_use",
        );
      return kaRound([commitBlock("t9")], "tool_use");
    });

    const result = await runKeyAnimator(noDb, kaArgs({ kaResearchCalls: 0 }));

    // Rounds: 2 refused-research rounds (cap 0+2), then the continuation.
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(result.trailerSource).toBe("continuation");
    expect(result.sidecar).toEqual(SIDECAR);

    const third = sent[2] as { role: string; content: unknown }[];
    // The demand is the ONLY addition after round 2's already-answered turn:
    // conversation = user(conte) + [assistant+user(tool_results)] × 2 + demand.
    expect(third).toHaveLength(6);
    expect(third[5]?.role).toBe("user");
    expect(third[5]?.content).toBe(TRAILER_DEMAND);
    // Round 2's tool_use id appears in EXACTLY one assistant turn — never
    // replayed — and no is_error result re-answers it.
    const flat = JSON.stringify(third);
    expect(flat.split('"r2"').length - 1).toBe(2); // one tool_use + its one tool_result
    expect(third[5]?.content).not.toContain("not usable");
  });

  it("continuation also fails → the probe fallback still closes the scene", async () => {
    mockStream.mockImplementation(() => proseOnly());
    mockProbe.mockResolvedValue(SIDECAR as never);

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(result.trailerSource).toBe("probe");
    expect(result.trailerFallback).toBe(true);
    expect(result.sidecar).toEqual(SIDECAR);
  });

  it("a rejected continuation is never fatal — it falls through to the probe", async () => {
    let round = 0;
    mockStream.mockImplementation(() => {
      round += 1;
      if (round === 1) return proseOnly();
      throw new Error("tool_choice rejected");
    });
    mockProbe.mockResolvedValue(SIDECAR as never);

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(result.trailerSource).toBe("probe");
    expect(result.sidecar).toEqual(SIDECAR);
  });

  it("both nets fail → no sidecar, and the source says so rather than lying", async () => {
    mockStream.mockImplementation(() => proseOnly());
    mockProbe.mockRejectedValue(new Error("probe down"));

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(result.sidecar).toBeNull();
    expect(result.trailerSource).toBe("none");
    expect(result.trailerFallback).toBe(true);
    // The prose still reaches the player — a lost sidecar never costs a scene.
    expect(result.prose).toBe("The tray went up at 20:11.");
  });

  it("a malformed trailer gets answered, not orphaned — the next request cannot 400", async () => {
    let round = 0;
    mockStream.mockImplementation(() => {
      round += 1;
      return round === 1
        ? // notable_beats is required; this input fails the contract.
          kaRound(
            [{ type: "text", text: "A scene. " }, commitBlock("bad", { decision_point: false })],
            "tool_use",
          )
        : kaRound([commitBlock("t2")], "tool_use");
    });

    const result = await runKeyAnimator(noDb, kaArgs());

    const second = mockStream.mock.calls[1]?.[0];
    const closing = second?.messages[2];
    expect(Array.isArray(closing?.content)).toBe(true);
    const blocks = closing?.content as { type: string; tool_use_id?: string }[];
    // Every tool_use in the replayed turn carries a result, or the API 400s.
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "bad", is_error: true });
    expect(blocks[1]).toMatchObject({ type: "text", text: TRAILER_DEMAND });
    expect(result.trailerSource).toBe("continuation");
  });

  it("a refusal returns before any trailer work — nothing to reconstruct", async () => {
    mockStream.mockImplementation(
      () =>
        ({
          stream: { on: () => {} },
          done: async () => ({
            message: { content: [], stop_reason: "refusal", model: "scripted", usage: {} },
            prose: "",
            sidecar: null,
            fallbackUsed: false,
            refused: true,
            costUsd: 0,
          }),
        }) as unknown as ReturnType<typeof streamNarration>,
    );

    const result = await runKeyAnimator(noDb, kaArgs());

    expect(result.refused).toBe(true);
    expect(result.trailerSource).toBe("none");
    expect(result.trailerFallback).toBe(false);
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});
