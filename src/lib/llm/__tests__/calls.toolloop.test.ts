import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The callJudgment investigation loop (§7.1 Director capability). The raw SDK
 * client is mocked so the loop is driven by scripted rounds — no live model,
 * no DB, no Langfuse. Asserts: a tool round feeds its result back and a final
 * structured round emits; the two-stage shape (tools ⊕ output_config, never
 * both); round-budget exhaustion still forces the final emit; every tool_use
 * is answered; and the single-shot path stays byte-identical when tools absent.
 */

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: vi.fn(async () => 0) }));

const SCHEMA = z.object({ ok: z.boolean(), note: z.string() });

const TOOL: Tool = {
  name: "get_seed_ledger",
  description: "test tool",
  input_schema: { type: "object", properties: {}, required: [] },
};

function assistantMessage(content: unknown[], stopReason: string) {
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
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const text = (t: string) => ({ type: "text", text: t, citations: null });
const jsonText = (obj: unknown) => text(JSON.stringify(obj));

beforeEach(() => createMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("callJudgment investigation loop", () => {
  it("runs a tool round, feeds the result back, then emits a final structured round", async () => {
    createMock
      .mockResolvedValueOnce(assistantMessage([toolUse("t1", "get_seed_ledger", {})], "tool_use"))
      .mockResolvedValueOnce(
        assistantMessage([text("Seeds look fine — planning now.")], "end_turn"),
      )
      .mockResolvedValueOnce(assistantMessage([jsonText({ ok: true, note: "done" })], "end_turn"));
    const execute = vi.fn(async () => "SEED LEDGER: (empty)");

    const out = await callJudgment(DEV_TIER_SELECTION, {
      name: "director_cycle",
      schema: SCHEMA,
      prompt: "investigate",
      tools: [TOOL],
      executeTool: execute,
      maxToolRounds: 6,
    });

    expect(out).toEqual({ ok: true, note: "done" });
    expect(execute).toHaveBeenCalledWith("get_seed_ledger", {});
    // round 0 tool_use → round 1 converges (end_turn) → round 2 final structured.
    expect(createMock).toHaveBeenCalledTimes(3);

    const investigationRound = createMock.mock.calls[0]?.[0];
    expect(investigationRound.tools).toEqual([TOOL]);
    expect(investigationRound.output_config).toBeUndefined();

    const finalRound = createMock.mock.calls[2]?.[0];
    expect(finalRound.tools).toBeUndefined();
    expect(finalRound.output_config).toBeDefined();
    const flat = JSON.stringify(finalRound.messages);
    expect(flat).toContain("tool_result");
    expect(flat).toContain("Investigation complete. Emit the structured output now.");
  });

  it("forces the final structured round when the round budget is exhausted", async () => {
    createMock
      .mockResolvedValueOnce(assistantMessage([toolUse("t1", "get_seed_ledger", {})], "tool_use"))
      .mockResolvedValueOnce(
        assistantMessage([jsonText({ ok: true, note: "forced" })], "end_turn"),
      );
    const execute = vi.fn(async () => "result");

    const out = await callJudgment(DEV_TIER_SELECTION, {
      name: "director_cycle",
      schema: SCHEMA,
      prompt: "investigate",
      tools: [TOOL],
      executeTool: execute,
      maxToolRounds: 1, // one investigation round, then the emit is forced
    });

    expect(out.note).toBe("forced");
    // The model still wanted to call a tool, but the budget forced the emit.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1]?.[0].output_config).toBeDefined();
    expect(createMock.mock.calls[1]?.[0].tools).toBeUndefined();
  });

  it("answers every tool_use in a round before the next request", async () => {
    createMock
      .mockResolvedValueOnce(
        assistantMessage(
          [toolUse("t1", "get_seed_ledger", { a: 1 }), toolUse("t2", "get_arc_state", { b: 2 })],
          "tool_use",
        ),
      )
      .mockResolvedValueOnce(
        assistantMessage([jsonText({ ok: true, note: "answered" })], "end_turn"),
      );
    const execute = vi.fn(async (name: string) => `result ${name}`);

    await callJudgment(DEV_TIER_SELECTION, {
      name: "director_cycle",
      schema: SCHEMA,
      prompt: "investigate",
      tools: [TOOL],
      executeTool: execute,
      maxToolRounds: 1,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const finalMessages = createMock.mock.calls[1]?.[0].messages as {
      role: string;
      content: unknown;
    }[];
    const toolResults = finalMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => (b as { type?: string }).type === "tool_result");
    expect(toolResults).toHaveLength(2);
  });

  it("keeps the single-shot path untouched when no tools are supplied", async () => {
    createMock.mockResolvedValueOnce(
      assistantMessage([jsonText({ ok: true, note: "single" })], "end_turn"),
    );

    const out = await callJudgment(DEV_TIER_SELECTION, {
      name: "outcome_judgment",
      schema: SCHEMA,
      prompt: "hello",
    });

    expect(out).toEqual({ ok: true, note: "single" });
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0]?.[0];
    expect(call.tools).toBeUndefined();
    expect(call.output_config).toBeDefined();
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
