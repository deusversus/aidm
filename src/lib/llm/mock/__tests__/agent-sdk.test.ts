import { describe, expect, it } from "vitest";
import { createMockQuery } from "../agent-sdk";
import { emptyRegistry } from "../fixtures";
import type { MockLlmFixture } from "../types";

/**
 * Unit tests for the Claude Agent SDK queryFn mock. Drives the mock
 * directly (no SDK subprocess) + asserts the emitted SDKMessage
 * stream shape matches what KA + Chronicler consume.
 */

function registryWith(...fixtures: MockLlmFixture[]) {
  const reg = emptyRegistry();
  for (const f of fixtures) {
    reg.byId.set(f.id, f);
    const bucket = reg.byProvider.get(f.provider) ?? [];
    bucket.push(f);
    reg.byProvider.set(f.provider, bucket);
  }
  return reg;
}

const textFixture: MockLlmFixture = {
  id: "ka-text",
  provider: "anthropic",
  match: { system_includes: ["You are KeyAnimator"] },
  response: {
    id: "msg_mock_ka",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Spike stares at the ceiling. Ash falls into his palm.",
      },
    ],
    model: "claude-opus-4-7",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 40 },
  },
};

describe("createMockQuery — SDK message stream shape", () => {
  it("emits system → stream_event deltas → result", async () => {
    const mock = createMockQuery(registryWith(textFixture));
    const messages = [];
    for await (const msg of mock({
      prompt: "look around",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "You are KeyAnimator — authorship tool.",
      } as never,
    })) {
      messages.push(msg);
    }
    // Shape: system + N stream_events + result
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    const lastMsg = messages[messages.length - 1] as {
      type: string;
      stop_reason: string;
      subtype: string;
    };
    expect(lastMsg.type).toBe("result");
    expect(lastMsg.subtype).toBe("success");
    expect(lastMsg.stop_reason).toBe("end_turn");

    // At least one stream_event with text_delta
    const deltas = messages.filter(
      (m) => (m as { type: string }).type === "stream_event",
    ) as Array<{
      event: { type: string; delta: { type: string; text: string } };
    }>;
    expect(deltas.length).toBeGreaterThan(0);
    const combined = deltas.map((d) => d.event.delta.text).join("");
    expect(combined).toContain("Spike stares");
  });

  it("propagates session_id across all messages in a single call", async () => {
    const mock = createMockQuery(registryWith(textFixture));
    const sessionIds = new Set<string>();
    for await (const msg of mock({
      prompt: "look around",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "You are KeyAnimator — authorship tool.",
      } as never,
    })) {
      const id = (msg as { session_id?: string }).session_id;
      if (id) sessionIds.add(id);
    }
    // All messages that carry session_id should share one value.
    expect(sessionIds.size).toBe(1);
  });

  it("returns total_cost_usd on result (pricing-derived)", async () => {
    const mock = createMockQuery(registryWith(textFixture));
    let finalResult: { total_cost_usd?: number } | null = null;
    for await (const msg of mock({
      prompt: "x",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "You are KeyAnimator",
      } as never,
    })) {
      if ((msg as { type: string }).type === "result") {
        finalResult = msg as { total_cost_usd?: number };
      }
    }
    expect(finalResult?.total_cost_usd).toBeGreaterThan(0);
    expect(finalResult?.total_cost_usd).toBeLessThan(1);
  });

  it("falls back to synth when no fixture matches (narrative mode)", async () => {
    const mock = createMockQuery(emptyRegistry());
    const deltas: string[] = [];
    for await (const msg of mock({
      prompt: "nothing specific",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "some random prompt",
      } as never,
    })) {
      if ((msg as { type: string }).type === "stream_event") {
        const d = (msg as { event: { delta: { text: string } } }).event.delta.text;
        deltas.push(d);
      }
    }
    expect(deltas.join("")).toMatch(/mock narrative/);
  });

  it("emits assistant message with tool_use blocks when fixture specifies them", async () => {
    const toolFixture: MockLlmFixture = {
      id: "chronicler-tool",
      provider: "anthropic",
      match: { system_includes: ["Chronicler"] },
      response: {
        id: "msg_chron",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Writing to catalog." },
          {
            type: "tool_use",
            id: "tool_1",
            name: "register_npc",
            input: { name: "Jet" },
          },
          {
            type: "tool_use",
            id: "tool_2",
            name: "write_episodic_summary",
            input: { content: "Turn summary" },
          },
        ],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 30 },
      },
    };
    const mock = createMockQuery(registryWith(toolFixture));
    const assistantMsgs = [];
    for await (const msg of mock({
      prompt: "chronicle",
      options: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: "Chronicler — post-turn archivist.",
      } as never,
    })) {
      if ((msg as { type: string }).type === "assistant") {
        assistantMsgs.push(msg);
      }
    }
    expect(assistantMsgs.length).toBe(1);
    const content = (
      assistantMsgs[0] as { message: { content: Array<{ type: string; name?: string }> } }
    ).message.content;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("tool_use");
    expect(content[0]?.name).toBe("register_npc");
    expect(content[1]?.name).toBe("write_episodic_summary");
  });

  it("extracts tool names from options.mcpServers for fixture matching", async () => {
    const hasToolFixture: MockLlmFixture = {
      id: "has-search-memory",
      provider: "anthropic",
      match: {
        system_includes: ["any"],
        has_tool: "search_memory",
      },
      response: {
        id: "msg_tool_matched",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Matched on tool availability." }],
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    };
    const mock = createMockQuery(registryWith(hasToolFixture));
    const deltas: string[] = [];
    for await (const msg of mock({
      prompt: "x",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "any system prompt",
        mcpServers: {
          "aidm-semantic": {
            tools: [{ name: "search_memory" }, { name: "get_npc_details" }],
          },
        },
      } as never,
    })) {
      if ((msg as { type: string }).type === "stream_event") {
        deltas.push((msg as { event: { delta: { text: string } } }).event.delta.text);
      }
    }
    expect(deltas.join("")).toContain("Matched on tool");
  });
});
