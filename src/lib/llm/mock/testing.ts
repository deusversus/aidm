import type { SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";

/**
 * Unified test-helper surface for the MockLLM infrastructure
 * (Phase E of docs/plans/mockllm.md).
 *
 * Replaces four hand-rolled inline patterns scattered across ~9 test
 * files (`fakeAnthropic` / `anthropicReturning` / `fakeGoogle` /
 * `stubQuery`) with one cohesive factory module. Each factory returns
 * a stub that matches the shape of the corresponding provider SDK's
 * surface, so callers pass it as a dep injection directly.
 *
 * These helpers are in-process stubs — no HTTP, no fixture registry.
 * For integration tests that want the full HTTP mock server, use
 * `startMockServer` from `./server.ts` instead.
 */

// ---------------------------------------------------------------------------
// Shared: response-sequence iterator
// ---------------------------------------------------------------------------

/**
 * Wrap an array of responses as a stateful iterator. Each consumption
 * advances the index; once exhausted, subsequent calls throw with a
 * clear error (tests that over-call reveal themselves loudly).
 *
 * This is the core primitive behind every provider stub — the provider
 * shape (Anthropic.messages, GoogleGenAI.models, etc.) is thin over
 * this iterator.
 */
export interface SequenceIterator<T> {
  /** Advance to the next response. Throws if exhausted. */
  next(label: string): T;
  /** How many responses have been consumed. */
  readonly consumed: number;
  /** Total items in the sequence. */
  readonly total: number;
}

export function sequence<T>(items: T[]): SequenceIterator<T> {
  let idx = 0;
  return {
    next(label: string): T {
      if (idx >= items.length) {
        throw new Error(
          `MockLLM stub sequence exhausted at call "${label}" (${items.length} responses prepared, ${idx + 1} consumed)`,
        );
      }
      const item = items[idx] as T;
      idx += 1;
      return item;
    },
    get consumed() {
      return idx;
    },
    get total() {
      return items.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic stub
// ---------------------------------------------------------------------------

export interface AnthropicStubResponse {
  /** Response text for the `messages.create` call. */
  text?: string;
  /** Throw this value instead of returning a response (error-path tests). */
  error?: unknown;
  /** Optional stop_reason override. */
  stopReason?: string;
  /** Optional usage stats override. */
  usage?: { input_tokens: number; output_tokens: number };
  /** Callback invoked with the call params for assertion ergonomics. */
  echo?: (params: unknown) => void;
}

/**
 * Build a stub that satisfies the subset of the Anthropic client our
 * `runStructuredAgent` uses: `client.messages.create(params)`. Returns
 * a factory matching the existing `getAnthropic`-like signature.
 *
 * Replaces `fakeAnthropic()` / `anthropicReturning()` / `anthropicSequence()`.
 */
export function createMockAnthropic(
  responses: AnthropicStubResponse[],
): () => Pick<Anthropic, "messages"> {
  const seq = sequence(responses);
  return () =>
    ({
      messages: {
        create: async (params: unknown) => {
          const r = seq.next("anthropic.messages.create");
          r.echo?.(params);
          if (r.error) throw r.error;
          return {
            id: `msg_stub_${seq.consumed}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: r.text ?? "" }],
            model: (params as { model?: string }).model ?? "claude-stub",
            stop_reason: r.stopReason ?? "end_turn",
            stop_sequence: null,
            usage: r.usage ?? { input_tokens: 100, output_tokens: 20 },
          };
        },
      },
    }) as unknown as Pick<Anthropic, "messages">;
}

// ---------------------------------------------------------------------------
// Google stub (mirrors Anthropic pattern for provider-dispatch tests)
// ---------------------------------------------------------------------------

export interface GoogleStubResponse {
  text?: string;
  error?: unknown;
  echo?: (params: unknown) => void;
}

/**
 * Build a stub satisfying the Google GenAI SDK surface our runner
 * uses: `client.models.generateContent(params)`. Replaces the
 * `fakeGoogle()` helper in _runner.test.ts.
 */
export function createMockGoogle(
  responses: GoogleStubResponse[],
): () => Pick<GoogleGenAI, "models"> {
  const seq = sequence(responses);
  return () =>
    ({
      models: {
        generateContent: async (params: unknown) => {
          const r = seq.next("google.models.generateContent");
          r.echo?.(params);
          if (r.error) throw r.error;
          return {
            text: r.text ?? "",
            candidates: [{ content: { parts: [{ text: r.text ?? "" }] } }],
          };
        },
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

// ---------------------------------------------------------------------------
// Claude Agent SDK queryFn stub
// ---------------------------------------------------------------------------

export interface AgentSdkStubResponse {
  /** Narrative text chunks to emit as stream_event deltas. */
  chunks?: string[];
  /**
   * Overrides for the terminal `result` message. Default: success with
   * stop_reason="end_turn", cost=0.
   */
  result?: {
    subtype?: "success" | "error_max_turns" | "error";
    stop_reason?: string | null;
    total_cost_usd?: number;
  };
  /** Tool-use blocks to include in an assistant message (Chronicler path). */
  toolUse?: Array<{ name: string; input?: Record<string, unknown>; id?: string }>;
  /** Throw this before emitting (simulates immediate subprocess failure). */
  error?: unknown;
  /**
   * Callback invoked with the call's { prompt, options } before any
   * messages emit. Use for wire-assertion tests that need to capture
   * what runKeyAnimator / runChronicler passed to the SDK.
   */
  onCall?: (args: { prompt: string; options: unknown }) => void;
}

/**
 * Build a Claude Agent SDK `queryFn` stub. Emits the SDKMessage shape
 * KA + Chronicler consume: system/init → stream_event deltas →
 * optional assistant tool_use → result. Replaces `stubQuery` in
 * chronicle.test.ts + any ad-hoc `queryFn` stubs across tests.
 */
export function createMockQueryFn(responses: AgentSdkStubResponse[]): typeof query {
  const seq = sequence(responses);
  const stub = async function* (args: {
    prompt: string;
    options: unknown;
  }): AsyncGenerator<SDKMessage, void, void> {
    const r = seq.next("agent-sdk.query");
    r.onCall?.(args);
    if (r.error) throw r.error;
    const sessionId = `stub_sess_${seq.consumed}`;

    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
    } as unknown as SDKMessage;

    for (const chunk of r.chunks ?? []) {
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

    if (r.toolUse && r.toolUse.length > 0) {
      yield {
        type: "assistant",
        session_id: sessionId,
        message: {
          id: `msg_stub_${seq.consumed}`,
          role: "assistant",
          content: r.toolUse.map((t, i) => ({
            type: "tool_use",
            id: t.id ?? `tool_${seq.consumed}_${i}`,
            name: t.name,
            input: t.input ?? {},
          })),
        },
      } as unknown as SDKMessage;
    }

    const result = r.result ?? {};
    yield {
      type: "result",
      subtype: result.subtype ?? "success",
      session_id: sessionId,
      stop_reason: result.stop_reason ?? "end_turn",
      total_cost_usd: result.total_cost_usd ?? 0,
      duration_ms: 10,
      num_turns: 1,
    } as unknown as SDKMessage;
  };
  return stub as unknown as typeof query;
}
