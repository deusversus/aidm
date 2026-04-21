import {
  type Options,
  type SDKMessage,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type query,
} from "@anthropic-ai/claude-agent-sdk";
import { type FixtureRegistry, matchFixture } from "./fixtures";
import { synthesizeAnthropicResponse, synthesizeCostUsd } from "./synth";
import type { AnthropicMessageResponse, RequestSignature } from "./types";

/**
 * Mock `query` function matching the Claude Agent SDK signature
 * (@anthropic-ai/claude-agent-sdk). Returns an async generator of
 * SDKMessage events, just like the real SDK — but synthesized from a
 * fixture registry + our request matchers instead of from spawning a
 * Claude subprocess.
 *
 * Phase D of docs/plans/mockllm.md. Enables KA + Chronicler to run
 * end-to-end against mock state (AIDM_MOCK_LLM=1) without an API key
 * + without spawning a Claude Code process subprocess.
 *
 * Fidelity notes:
 *   - We emit the exact shape KA and Chronicler consume: `system`
 *     (session_id), `stream_event` (content_block_delta → text_delta)
 *     for every text chunk, `result` (subtype="success" | error
 *     subtypes, session_id, stop_reason, total_cost_usd).
 *   - We do NOT simulate tool dispatch, subagent spawning, thinking
 *     tokens, or interruption. If a scenario needs those, the fixture
 *     must specify the exact content blocks the SDK would emit; we
 *     pass them through verbatim. Full tool-dispatch fidelity is
 *     future work.
 *   - `options.tools` / `options.mcpServers` / `options.agents` are
 *     inspected only to extract tool names for fixture matching — the
 *     mock doesn't actually invoke any of them.
 */

/**
 * Chunk size when synthesizing streaming deltas. Matches the heuristic
 * used by `server.ts` for raw Anthropic streaming — keeps the mock
 * response cadence consistent across transport layers.
 */
const CHUNK_SIZE = 40;

export function createMockQuery(registry: FixtureRegistry): typeof query {
  // The real `query` accepts { prompt, options } and returns an async
  // iterable of SDKMessage. We mirror that shape. Cast to the SDK's
  // return type at the end — the SDKMessage union is too tight to
  // satisfy without some gymnastics, and the tests that consume this
  // already cast the stub queries.
  const mockQuery = async function* (args: {
    prompt: string;
    options: Options;
  }): AsyncGenerator<SDKMessage, void, void> {
    const { prompt, options } = args;
    const sessionId = `mock_sess_${Math.random().toString(36).slice(2, 10)}`;
    const model = options.model ?? "claude-mock";

    // Flatten the systemPrompt into a single string for matching.
    // options.systemPrompt is string | string[] with the boundary sentinel
    // between cached + dynamic portions in KA. Strip the sentinel.
    const systemPromptRaw = options.systemPrompt;
    const systemText =
      typeof systemPromptRaw === "string"
        ? systemPromptRaw
        : Array.isArray(systemPromptRaw)
          ? systemPromptRaw.filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join("\n\n")
          : "";

    // Extract tool names from the MCP servers' registered tool lists
    // when available. Agent SDK's Options.mcpServers is a record of
    // MCP configurations; each has a `tools` array with `name` fields.
    const toolNames: string[] = [];
    const mcpServers = options.mcpServers as
      | Record<string, { tools?: Array<{ name?: string }> } | undefined>
      | undefined;
    if (mcpServers) {
      for (const server of Object.values(mcpServers)) {
        for (const t of server?.tools ?? []) {
          if (typeof t?.name === "string") toolNames.push(t.name);
        }
      }
    }

    const signature: RequestSignature = {
      provider: "anthropic",
      endpoint: "/v1/messages",
      model,
      system: systemText,
      messages: [{ role: "user", text: prompt }],
      toolNames,
      streaming: true,
      rawBody: { prompt, options: { model, systemPrompt: systemText } },
    };

    const outcome = matchFixture(registry, signature);
    let response: AnthropicMessageResponse;
    if (outcome.kind === "fixture" && outcome.fixture.response) {
      response = outcome.fixture.response;
    } else if (outcome.kind === "fixture" && outcome.fixture.streaming) {
      // Fixture has only streaming chunks — reconstruct an equivalent response.
      const text = outcome.fixture.streaming.chunks.map((c) => c.text).join("");
      response = {
        id: `msg_mock_${outcome.fixture.id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(1, Math.ceil(systemText.length / 4)),
          output_tokens: Math.max(1, Math.ceil(text.length / 4)),
        },
      };
    } else {
      response = synthesizeAnthropicResponse(signature);
    }

    // 1. system/init message — carries session_id that KA/Chronicler pin.
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
      tools: toolNames,
      mcp_servers: [],
      model,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      apiKeySource: "mock",
    } as unknown as SDKMessage;

    // 2. Text content as stream_event → content_block_delta → text_delta
    //    chunks. Chunk size mirrors server.ts heuristic.
    for (const block of response.content) {
      if (block.type !== "text") continue;
      for (let i = 0; i < block.text.length; i += CHUNK_SIZE) {
        const chunk = block.text.slice(i, i + CHUNK_SIZE);
        yield {
          type: "stream_event",
          session_id: sessionId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunk },
          },
        } as unknown as SDKMessage;
      }
    }

    // 3. Emit assistant message with the tool_use blocks (if any) so
    //    Chronicler's countToolUseBlocks() reflects the fixture's
    //    intended tool-call count.
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      yield {
        type: "assistant",
        session_id: sessionId,
        message: {
          id: response.id,
          role: "assistant",
          content: toolUseBlocks,
        },
      } as unknown as SDKMessage;
    }

    // 4. Terminal result message. Chronicler + KA both parse this to
    //    get stop_reason + cost + sessionId. subtype="success" is the
    //    happy path; other subtypes would be failures we don't model yet.
    const costUsd = synthesizeCostUsd(response);
    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      stop_reason: response.stop_reason,
      total_cost_usd: costUsd,
      duration_ms: 100,
      num_turns: 1,
      usage: response.usage,
    } as unknown as SDKMessage;
  };

  // Cast once at the boundary so callers see the exact SDK type.
  return mockQuery as unknown as typeof query;
}
