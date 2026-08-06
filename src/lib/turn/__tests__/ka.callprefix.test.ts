import type { Db } from "@/lib/db";
import { Conte } from "@/lib/types/conte";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKeyAnimator } from "../ka";

/**
 * CALL-LEVEL prefix stability (M3R4). Within ONE turn, every narration call
 * after the first must be an EXTENSION of the call before it: identical tools,
 * identical system blocks, identical leading messages — and identical values
 * for every request field the prompt cache keys on.
 *
 * WHY THIS TEST EXISTS, AND WHY THE EXISTING ONES MISSED IT. The turn-level
 * prefix tests (blocks/__tests__/assemble.test.ts) assert that appending an
 * exchange leaves every prior BLOCK byte-identical, and they pass today — they
 * always did. The soak's §5.6 metric watches the turn's FIRST narration call,
 * so it grades turn-to-turn caching and cannot see inside a turn at all. Both
 * were green while the N=50 soak burned $0.66 re-writing the exchange window
 * mid-turn, because the divergence was never in the BYTES: it was a request
 * PARAMETER. The trailer round flipped `tool_choice` from `auto` to a forced
 * `commit_scene`, which leaves the tools/system cache intact but invalidates
 * the MESSAGES cache — where Block 3 has lived since M3R2 C2. Byte-equality
 * assertions are structurally blind to that, so this test asserts the whole
 * request shape, not just the blocks.
 *
 * Hermetic: the Anthropic client, Langfuse, the meter and the research tools
 * are all stubbed. No model, no Postgres.
 */

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: vi.fn(), stream: streamMock } }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));
vi.mock("@/lib/turn/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/turn/tools")>();
  return { ...actual, executeSearchLore: vi.fn(async () => "The Red Sash run the piers.") };
});

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

const SIDECAR = {
  scene_cast_delta: [],
  decision_point: false,
  intended_seed_mentions: [],
  notable_beats: ["the gantry stayed lit"],
};

/** One scripted API round, in the SDK's stream shape. */
function round(blocks: Block[], stopReason: string) {
  return {
    on: (event: string, cb: (t: string) => void) => {
      if (event === "text") for (const b of blocks) if (b.type === "text") cb(b.text);
    },
    finalMessage: async () => ({
      id: "msg_scripted",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  };
}

const breakpoint = { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } };

/** Blocks 1–2 + pins, as blocks/assemble.ts emits them. */
const SYSTEM: TextBlockParam[] = [
  { type: "text", text: "# Settei\nthe charter", ...breakpoint },
  { type: "text", text: "## Story so far\n\nbeat one", ...breakpoint },
  { type: "text", text: "## Pinned passages\n\nthe Jericho", ...breakpoint },
];

/** Block 3 as conversation, moving breakpoint on the last assistant message. */
const EXCHANGES: MessageParam[] = [
  { role: "user", content: [{ type: "text", text: "[Turn 1]\nI walk the pier." }] },
  { role: "assistant", content: [{ type: "text", text: "Rain on the gantry." }] },
  { role: "user", content: [{ type: "text", text: "[Turn 2]\nI wait." }] },
  { role: "assistant", content: [{ type: "text", text: "The stand closes.", ...breakpoint }] },
];

function kaArgs() {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    turnNumber: 3,
    conte: Conte.parse({ turn_id: 3, tier: "genga" }),
    playerInput: "I go loud",
    exchangeMessages: EXCHANGES,
    system: SYSTEM,
    selection: {
      narration: "claude-sonnet-5" as const,
      judgment: "claude-sonnet-5" as const,
      probe: "claude-haiku-4-5" as const,
    },
    effort: "high" as const,
    maxTokens: 1_800,
    kaResearchCalls: 2,
    ladderSteps: [],
    profileIds: [],
    emit: () => {},
  };
}

/** Request bodies as the wire saw them — snapshotted, because ka mutates one
 *  `messages` array across rounds and mock.calls holds live references. */
function sentRequests(): Record<string, unknown>[] {
  return streamMock.mock.calls.map((c) => JSON.parse(JSON.stringify(c[0])));
}

beforeEach(() => streamMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("call-level prefix stability within one turn (§5.6)", () => {
  /** A research round-trip, then a scene with no trailer, then the warm ask. */
  function scriptThreeRounds() {
    let n = 0;
    streamMock.mockImplementation(() => {
      n += 1;
      if (n === 1) {
        return round(
          [
            { type: "text", text: "Checking. " },
            { type: "tool_use", id: "r1", name: "search_lore", input: { query: "Red Sash" } },
          ],
          "tool_use",
        );
      }
      if (n === 2) return round([{ type: "text", text: "The Jericho came up." }], "end_turn");
      return round(
        [{ type: "tool_use", id: "t1", name: "commit_scene", input: SIDECAR }],
        "tool_use",
      );
    });
  }

  it("every call EXTENDS the one before it — leading messages byte-identical", async () => {
    scriptThreeRounds();

    await runKeyAnimator({} as Db, kaArgs());
    const reqs = sentRequests();
    expect(reqs).toHaveLength(3);

    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1]?.messages as unknown[];
      const curr = reqs[i]?.messages as unknown[];
      expect(curr.length).toBeGreaterThanOrEqual(prev.length);
      // Byte-for-byte up to the previous call's tail. Anything less and the
      // model re-reads a prefix it already paid to cache.
      expect(JSON.stringify(curr.slice(0, prev.length))).toBe(JSON.stringify(prev));
    }
  });

  it("tools and system blocks never move — the cached head is one head all turn", async () => {
    scriptThreeRounds();

    await runKeyAnimator({} as Db, kaArgs());
    const reqs = sentRequests();

    const head = (r: Record<string, unknown>) =>
      JSON.stringify({ model: r.model, tools: r.tools, system: r.system });
    for (const r of reqs) expect(head(r)).toBe(head(reqs[0] as Record<string, unknown>));
    // The breakpoints are still where the assembler put them.
    expect((reqs[0]?.system as TextBlockParam[]).filter((b) => b.cache_control)).toHaveLength(3);
  });

  it("CACHE-KEY FIELDS hold constant — tool_choice included (the miss this test exists for)", async () => {
    scriptThreeRounds();

    await runKeyAnimator({} as Db, kaArgs());
    const reqs = sentRequests();

    // tool_choice is outside the tools/system key but INSIDE the messages key,
    // and Block 3 lives in messages (M3R2 C2). A change here re-writes the
    // whole exchange window at the 1h 2x rate — measured, N=50 soak: 17
    // follow-ups re-created 115,408 tokens for $0.66.
    const cacheKey = (r: Record<string, unknown>) =>
      JSON.stringify({
        model: r.model,
        tools: r.tools,
        system: r.system,
        tool_choice: r.tool_choice,
        thinking: r.thinking,
        output_config: r.output_config,
      });
    for (const r of reqs) expect(cacheKey(r)).toBe(cacheKey(reqs[0] as Record<string, unknown>));
    expect(reqs[0]?.tool_choice).toEqual({ type: "auto" });
  });

  it("the storyboard is rendered ONCE — no follow-up re-renders the conte", async () => {
    scriptThreeRounds();

    await runKeyAnimator({} as Db, kaArgs());
    const reqs = sentRequests();

    const conteOf = (r: Record<string, unknown>) =>
      JSON.stringify((r.messages as { content: unknown }[])[EXCHANGES.length]?.content);
    for (const r of reqs) expect(conteOf(r)).toBe(conteOf(reqs[0] as Record<string, unknown>));
    expect(conteOf(reqs[0] as Record<string, unknown>)).toContain("Storyboard");
  });

  it("the forced escalation is the ONE sanctioned posture change, and it is last", async () => {
    // The scene drops the trailer, the warm ask lands nothing, the demand runs.
    let n = 0;
    streamMock.mockImplementation(() => {
      n += 1;
      if (n <= 2) return round([{ type: "text", text: "prose." }], "end_turn");
      return round(
        [{ type: "tool_use", id: "t2", name: "commit_scene", input: SIDECAR }],
        "tool_use",
      );
    });

    await runKeyAnimator({} as Db, kaArgs());
    const reqs = sentRequests();

    expect(reqs).toHaveLength(3);
    // Calls 1–2 share a posture (that is the whole point); only the last
    // escalates, and it pays the window re-write exactly once per turn.
    expect(reqs[0]?.tool_choice).toEqual({ type: "auto" });
    expect(reqs[1]?.tool_choice).toEqual({ type: "auto" });
    expect(reqs[2]?.tool_choice).toEqual({ type: "tool", name: "commit_scene" });
    // Everything else about the escalation is byte-identical to the ask.
    const { tool_choice: _a, max_tokens: _b, ...ask } = reqs[1] as Record<string, unknown>;
    const { tool_choice: _c, max_tokens: _d, ...demand } = reqs[2] as Record<string, unknown>;
    expect(JSON.stringify(demand)).toBe(JSON.stringify(ask));
  });
});
