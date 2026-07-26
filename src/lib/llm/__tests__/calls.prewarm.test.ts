import { prewarmPrefix, streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { KA_TOOLS } from "@/lib/turn/tools";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-warm request-shape parity (M2R5 C1). The pre-warm exists to write the
 * entry the KA reads; the API renders `tools` ahead of `system` in the cache
 * key, so any divergence in either field writes an entry the narration call
 * structurally cannot hit. Pinned by mock capture: same tools, same system,
 * max_tokens 0, nothing cacheable in the message turn.
 */

const { createMock, streamMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  streamMock: vi.fn(),
}));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createMock, stream: streamMock } }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));

/** Blocks 1–3 as the assembler renders them: the breakpoint rides the tail. */
const SYSTEM: TextBlockParam[] = [
  { type: "text", text: "# Settei", cache_control: { type: "ephemeral", ttl: "1h" } },
  { type: "text", text: "# Compacted beats", cache_control: { type: "ephemeral", ttl: "1h" } },
  { type: "text", text: "# Working window", cache_control: { type: "ephemeral", ttl: "1h" } },
];

const MESSAGE = {
  id: "msg_scripted",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [],
  stop_reason: "max_tokens",
  stop_sequence: null,
  usage: {
    input_tokens: 4,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 12_288,
  },
};

beforeEach(() => {
  createMock.mockReset();
  streamMock.mockReset();
  createMock.mockResolvedValue(MESSAGE);
  streamMock.mockImplementation(() => ({
    on: () => {},
    finalMessage: async () => ({ ...MESSAGE, stop_reason: "end_turn" }),
  }));
});
afterEach(() => vi.clearAllMocks());

describe("prewarmPrefix request shape", () => {
  it("sends max_tokens 0, the supplied tools, and the blocks verbatim", async () => {
    await prewarmPrefix(DEV_TIER_SELECTION, SYSTEM, KA_TOOLS, { campaignId: "c1" });

    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0]?.[0];
    expect(req.model).toBe(DEV_TIER_SELECTION.narration);
    // max_tokens 0 is the documented pre-warm form: prefill runs, the cache
    // writes, zero output bills. (The superseded form paid for one token.)
    expect(req.max_tokens).toBe(0);
    expect(req.tools).toEqual(KA_TOOLS);
    expect(req.system).toBe(SYSTEM);
    // tool_choice {tool|any} is rejected alongside max_tokens 0 — and the KA's
    // `auto` never enters the tools/system cache key, so it is simply absent.
    expect(req.tool_choice).toBeUndefined();
  });

  it("the placeholder turn cannot enter the cached prefix", async () => {
    await prewarmPrefix(DEV_TIER_SELECTION, SYSTEM, KA_TOOLS);

    const req = createMock.mock.calls[0]?.[0];
    // One minimal, non-whitespace user turn — an empty messages array is a 400.
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(String(req.messages[0].content).trim().length).toBeGreaterThan(0);
    // Every breakpoint lives on a system block, so nothing in `messages` is
    // part of what gets cached.
    expect(JSON.stringify(req.messages)).not.toContain("cache_control");
    expect(SYSTEM[SYSTEM.length - 1]?.cache_control).toBeDefined();
  });

  it("returns the cache accounting the caller meters on", async () => {
    const out = await prewarmPrefix(DEV_TIER_SELECTION, SYSTEM, KA_TOOLS);
    expect(out.cacheCreation).toBe(12_288);
    expect(out.cacheRead).toBe(0);
  });
});

describe("pre-warm ↔ narration parity", () => {
  it("both requests carry byte-identical tools and system", async () => {
    await prewarmPrefix(DEV_TIER_SELECTION, SYSTEM, KA_TOOLS, { campaignId: "c1" });
    const { done } = streamNarration({
      name: "ka_narration",
      selection: DEV_TIER_SELECTION,
      system: SYSTEM,
      messages: [{ role: "user", content: "# Storyboard" }],
      maxTokens: 1_000,
      effort: "high",
      tools: KA_TOOLS,
      campaignId: "c1",
    });
    await done();

    const prewarmReq = createMock.mock.calls[0]?.[0];
    const narrationReq = streamMock.mock.calls[0]?.[0];
    expect(JSON.stringify(narrationReq.tools)).toBe(JSON.stringify(prewarmReq.tools));
    expect(JSON.stringify(narrationReq.system)).toBe(JSON.stringify(prewarmReq.system));
    // The narration call adds tool_choice; per the invalidation hierarchy that
    // touches only the messages cache, never the tools/system prefix.
    expect(narrationReq.tool_choice).toEqual({ type: "auto" });
  });
});
