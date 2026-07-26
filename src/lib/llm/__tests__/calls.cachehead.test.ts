import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { recordModelCall } from "@/lib/observability/meter";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * `cacheHead` (M2R5 C2) — the opt-in head breakpoint for callStructured.
 * OFF is the contract: every existing caller's request must stay byte-for-byte
 * what it was before this option existed, because judgment/probe systems run
 * under the per-model cache minimums and a stray breakpoint would buy a write
 * nothing ever reads. ON, it touches exactly two places: the system block and
 * the tail of the opening user turn.
 */

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({
    messages: {
      create: createMock,
      stream: (params: unknown) => ({ finalMessage: () => createMock(params) }),
    },
  }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));

const SCHEMA = z.object({ ok: z.boolean() });
const SYSTEM = "You are the showrunner.";
const PROMPT = "Here is the dossier.";

const TOOL: Tool = {
  name: "get_seed_ledger",
  description: "test tool",
  input_schema: { type: "object", properties: {}, required: [] },
};

function emit(content: unknown[], stopReason: string) {
  return {
    id: "msg_scripted",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}
const jsonText = (obj: unknown) => ({ type: "text", text: JSON.stringify(obj), citations: null });

beforeEach(() => createMock.mockReset());
afterEach(() => vi.clearAllMocks());

async function capture(cacheHead?: "5m" | "1h") {
  createMock.mockResolvedValueOnce(emit([jsonText({ ok: true })], "end_turn"));
  await callJudgment(DEV_TIER_SELECTION, {
    name: "outcome_judgment",
    schema: SCHEMA,
    system: SYSTEM,
    prompt: PROMPT,
    ...(cacheHead ? { cacheHead } : {}),
  });
  const params = createMock.mock.calls[createMock.mock.calls.length - 1]?.[0];
  return params as Record<string, unknown>;
}

describe("callStructured cacheHead — off by default", () => {
  it("leaves the request byte-identical to the uncached form", async () => {
    const bare = await capture();

    // Bare strings, exactly as every caller has always sent them.
    expect(bare.system).toBe(SYSTEM);
    expect(bare.messages).toEqual([{ role: "user", content: PROMPT }]);
    expect(JSON.stringify(bare)).not.toContain("cache_control");
    // No stray fields: the option adds nothing when unasked. (Haiku carries
    // neither adaptive thinking nor effort control, so this is the whole set.)
    expect(Object.keys(bare).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "output_config",
      "system",
    ]);
  });

  it("differs from the cacheHead request in exactly those two fields", async () => {
    const bare = await capture();
    createMock.mockReset();
    const cached = await capture("5m");

    // Everything else — model, max_tokens, output_config (format + effort) —
    // is identical, so opting in cannot silently move another dial. The format
    // is compared serialized: zodOutputFormat mints a fresh object per call,
    // so identity comparison would fail on the helper, not on the request.
    expect(Object.keys(cached).sort()).toEqual(Object.keys(bare).sort());
    expect(cached.model).toBe(bare.model);
    expect(cached.max_tokens).toBe(bare.max_tokens);
    expect(JSON.stringify(cached.output_config)).toBe(JSON.stringify(bare.output_config));
  });

  it("keeps the investigation loop's rounds bare when unasked", async () => {
    createMock
      .mockResolvedValueOnce(
        emit([{ type: "tool_use", id: "t1", name: "get_seed_ledger", input: {} }], "tool_use"),
      )
      .mockResolvedValueOnce(emit([jsonText({ ok: true })], "end_turn"));

    await callJudgment(DEV_TIER_SELECTION, {
      name: "director_cycle",
      schema: SCHEMA,
      system: SYSTEM,
      prompt: PROMPT,
      tools: [TOOL],
      executeTool: async () => "ledger",
      maxToolRounds: 1,
    });

    for (const call of createMock.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("cache_control");
    }
  });
});

describe("callStructured cacheHead — on", () => {
  it("puts the ttl on the system block and the tail of messages[0]", async () => {
    const cached = await capture("5m");

    expect(cached.system).toEqual([
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
    expect(cached.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral", ttl: "5m" } }],
      },
    ]);
  });

  it("honors the 1h ttl when asked for it", async () => {
    const cached = await capture("1h");
    const system = cached.system as { cache_control: { ttl: string } }[];
    expect(system[0]?.cache_control.ttl).toBe("1h");
  });

  it("marks the head on every investigation round — that is what amortizes the write", async () => {
    createMock
      .mockResolvedValueOnce(
        emit([{ type: "tool_use", id: "t1", name: "get_seed_ledger", input: {} }], "tool_use"),
      )
      .mockResolvedValueOnce(emit([jsonText({ ok: true })], "end_turn"));

    await callJudgment(DEV_TIER_SELECTION, {
      name: "director_cycle",
      schema: SCHEMA,
      system: SYSTEM,
      prompt: PROMPT,
      tools: [TOOL],
      executeTool: async () => "ledger",
      maxToolRounds: 1,
      cacheHead: "5m",
    });

    expect(createMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of createMock.mock.calls) {
      const params = call[0] as { system: unknown[]; messages: { content: unknown }[] };
      // The head is the same two blocks in every round — the loop's growing
      // tail rides behind it, never in front of it.
      expect(params.system).toEqual([
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "5m" } },
      ]);
      expect(params.messages[0]?.content).toEqual([
        { type: "text", text: PROMPT, cache_control: { type: "ephemeral", ttl: "5m" } },
      ]);
      // Exactly two marks — the API allows four, and C3 needs the other two.
      expect(JSON.stringify(params).split("cache_control").length - 1).toBe(2);
    }
  });
});

describe("the usage split's writer→reader hop (C2 audit)", () => {
  const meterMock = vi.mocked(recordModelCall);

  it("passes usage.cache_creation to the meter when the API reports it", async () => {
    const msg = emit([jsonText({ ok: true })], "end_turn");
    (msg.usage as Record<string, unknown>).cache_creation_input_tokens = 700;
    (msg.usage as Record<string, unknown>).cache_creation = {
      ephemeral_5m_input_tokens: 700,
      ephemeral_1h_input_tokens: 0,
    };
    createMock.mockResolvedValueOnce(msg);
    await callJudgment(DEV_TIER_SELECTION, {
      name: "outcome_judgment",
      schema: SCHEMA,
      system: SYSTEM,
      prompt: PROMPT,
    });
    const recorded = meterMock.mock.calls.at(-1)?.[0];
    expect(recorded?.usage.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 700,
      ephemeral_1h_input_tokens: 0,
    });
    expect(recorded?.usage.cache_creation_input_tokens).toBe(700);
  });

  it("omits the split when the API does not report one (absent, never invented)", async () => {
    createMock.mockResolvedValueOnce(emit([jsonText({ ok: true })], "end_turn"));
    await callJudgment(DEV_TIER_SELECTION, {
      name: "outcome_judgment",
      schema: SCHEMA,
      system: SYSTEM,
      prompt: PROMPT,
    });
    const recorded = meterMock.mock.calls.at(-1)?.[0];
    expect(recorded?.usage.cache_creation).toBeUndefined();
  });
});
