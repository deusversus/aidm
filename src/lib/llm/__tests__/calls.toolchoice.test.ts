import { streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { KA_TOOLS } from "@/lib/turn/tools";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * tool_choice pass-through (M3 C1). Two callers need a posture other than
 * `auto`, and neither may cost the cached prefix:
 *
 *  - the recap/yokoku composers send the KA's tool ARRAY under `none`, so
 *    their prefix can share the KA's cache entry instead of writing a cold
 *    one (tools render ahead of `system` in the cache key; `tools: []` made
 *    the composer's prefix structurally unable to hit it);
 *  - the trailer continuation forces `commit_scene`, where no prose is wanted.
 *
 * The load-bearing property for everyone else is that an absent toolChoice
 * changes nothing at all.
 */

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: vi.fn(), stream: streamMock } }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));

const SYSTEM: TextBlockParam[] = [
  { type: "text", text: "# Settei", cache_control: { type: "ephemeral", ttl: "1h" } },
];

const MESSAGE = {
  id: "msg_scripted",
  type: "message",
  role: "assistant",
  model: DEV_TIER_SELECTION.narration,
  content: [],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 0 },
};

function baseOpts() {
  return {
    name: "composer",
    selection: DEV_TIER_SELECTION,
    system: SYSTEM,
    messages: [{ role: "user" as const, content: "compose" }],
    maxTokens: 1_000,
    tools: KA_TOOLS,
    campaignId: "c1",
  };
}

beforeEach(() => {
  streamMock.mockReset();
  streamMock.mockImplementation(() => ({ on: () => {}, finalMessage: async () => MESSAGE }));
});
afterEach(() => vi.clearAllMocks());

describe("tool_choice pass-through", () => {
  it("absent: the request is byte-identical to one that never knew the field", async () => {
    await streamNarration(baseOpts()).done();
    const withoutField = JSON.stringify(streamMock.mock.calls[0]?.[0]);

    streamMock.mockClear();
    await streamNarration({ ...baseOpts(), toolChoice: undefined }).done();
    const withUndefined = JSON.stringify(streamMock.mock.calls[0]?.[0]);

    expect(withUndefined).toBe(withoutField);
    expect(JSON.parse(withoutField).tool_choice).toEqual({ type: "auto" });
  });

  it("none: the KA's tool array rides along with the door bolted shut", async () => {
    await streamNarration({ ...baseOpts(), toolChoice: { type: "none" } }).done();

    const req = streamMock.mock.calls[0]?.[0];
    expect(req.tool_choice).toEqual({ type: "none" });
    // The prefix the cache keys on — tools, then system — matches the KA's.
    expect(JSON.stringify(req.tools)).toBe(JSON.stringify(KA_TOOLS));
    expect(JSON.stringify(req.system)).toBe(JSON.stringify(SYSTEM));
  });

  it("none vs auto differ ONLY in tool_choice — the cached prefix is untouched", async () => {
    await streamNarration(baseOpts()).done();
    const auto = streamMock.mock.calls[0]?.[0];
    streamMock.mockClear();
    await streamNarration({ ...baseOpts(), toolChoice: { type: "none" } }).done();
    const none = streamMock.mock.calls[0]?.[0];

    const { tool_choice: _a, ...autoRest } = auto;
    const { tool_choice: _n, ...noneRest } = none;
    expect(JSON.stringify(noneRest)).toBe(JSON.stringify(autoRest));
  });

  it("tool: the trailer can be demanded outright", async () => {
    await streamNarration({
      ...baseOpts(),
      toolChoice: { type: "tool", name: "commit_scene" },
    }).done();

    expect(streamMock.mock.calls[0]?.[0].tool_choice).toEqual({
      type: "tool",
      name: "commit_scene",
    });
  });

  it("an empty tool array still drops BOTH fields — tool_choice with no tools is a 400", async () => {
    await streamNarration({ ...baseOpts(), tools: [], toolChoice: { type: "none" } }).done();

    const req = streamMock.mock.calls[0]?.[0];
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });
});
