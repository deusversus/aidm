import { z } from "zod";

/**
 * Shared types for the MockLLM infrastructure (docs/plans/mockllm.md).
 *
 * Two consumers:
 *   - `fixtures.ts` validates YAML fixture files against these shapes.
 *   - `server.ts` / testing helpers build RequestSignatures from incoming
 *     provider SDK calls and look them up against loaded fixtures.
 *
 * Shapes are intentionally minimal. We're not reproducing the full
 * Anthropic / Google / OpenAI SDK types — just what we need to match,
 * synthesize, and replay.
 */

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

export const MockProvider = z.enum(["anthropic", "google", "openai"]);
export type MockProvider = z.infer<typeof MockProvider>;

// ---------------------------------------------------------------------------
// Anthropic Message response shape (the subset we emit)
// ---------------------------------------------------------------------------

export const AnthropicTextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const AnthropicToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const AnthropicContentBlock = z.discriminatedUnion("type", [
  AnthropicTextBlock,
  AnthropicToolUseBlock,
]);

export const AnthropicUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

export const AnthropicStopReason = z.enum([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
]);

export const AnthropicMessageResponse = z.object({
  id: z.string().default(() => `msg_mock_${Math.random().toString(36).slice(2, 10)}`),
  type: z.literal("message").default("message"),
  role: z.literal("assistant").default("assistant"),
  content: z.array(AnthropicContentBlock),
  model: z.string().default("claude-mock"),
  stop_reason: AnthropicStopReason.default("end_turn"),
  stop_sequence: z.string().nullable().default(null),
  usage: AnthropicUsage,
});
export type AnthropicMessageResponse = z.infer<typeof AnthropicMessageResponse>;

// ---------------------------------------------------------------------------
// Streaming chunk shape for fixtures that specify streaming
// ---------------------------------------------------------------------------

export const StreamingChunk = z.object({
  /** Milliseconds of delay BEFORE this chunk emits. First chunk's delay = ttft. */
  delay_ms: z.number().int().nonnegative().default(0),
  /** Text appended to the streaming content block. */
  text: z.string(),
});
export type StreamingChunk = z.infer<typeof StreamingChunk>;

export const StreamingConfig = z.object({
  chunks: z.array(StreamingChunk).min(1),
  /** Delay before emitting the final `message_stop` event. */
  end_delay_ms: z.number().int().nonnegative().default(100),
});
export type StreamingConfig = z.infer<typeof StreamingConfig>;

// ---------------------------------------------------------------------------
// Fixture match rules
// ---------------------------------------------------------------------------

export const MatchRules = z
  .object({
    /** Exact SHA-256 over the normalized request signature. Highest precedence. */
    prompt_hash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    /** Model string must start with this prefix. */
    model_prefix: z.string().optional(),
    /** Every substring must appear somewhere in the normalized system prompt. */
    system_includes: z.array(z.string()).optional(),
    /** Every substring must appear in at least one user message's text content. */
    user_includes: z.array(z.string()).optional(),
    /** A tool definition with this name must be present in the request's tools[]. */
    has_tool: z.string().optional(),
  })
  .refine(
    (r) =>
      !!(
        r.prompt_hash ||
        r.model_prefix ||
        r.system_includes?.length ||
        r.user_includes?.length ||
        r.has_tool
      ),
    { message: "match block must specify at least one rule" },
  );
export type MatchRules = z.infer<typeof MatchRules>;

// ---------------------------------------------------------------------------
// MockLlmFixture — the authored unit
// ---------------------------------------------------------------------------

export const MockLlmFixture = z.object({
  /** Stable globally-unique id. Used for error messages + record-mode filenames. */
  id: z.string().min(1),
  provider: MockProvider,
  /**
   * Endpoint path. Defaults by provider:
   *   anthropic → /v1/messages
   *   google    → /v1beta/models/:model:generateContent   (deferred M3.5)
   *   openai    → /v1/chat/completions                    (deferred M5.5)
   */
  endpoint: z.string().optional(),
  match: MatchRules,
  /**
   * Non-streaming response. Required unless `streaming` is specified.
   * When both present, server picks based on request's `stream: true`.
   */
  response: AnthropicMessageResponse.optional(),
  /**
   * Streaming response. Chunks delivered sequentially with configured delays.
   * Used when the request specifies `stream: true`.
   */
  streaming: StreamingConfig.optional(),
  /** Freeform notes for the author; not used at runtime. */
  notes: z.string().optional(),
  /** When this fixture was recorded (ISO 8601). Record mode fills this. */
  recorded_at: z.string().optional(),
});
export type MockLlmFixture = z.infer<typeof MockLlmFixture>;

// ---------------------------------------------------------------------------
// RequestSignature — what the server / test helper builds from each
// incoming provider SDK call, then matches against fixture.match rules.
// ---------------------------------------------------------------------------

export interface RequestSignature {
  provider: MockProvider;
  endpoint: string;
  model: string;
  /** Flattened system prompt (for multi-block systems, joined with "\n\n"). */
  system: string;
  /** Array of {role, text} pairs — text extracted from content blocks. */
  messages: Array<{ role: string; text: string }>;
  /** Tool names the caller registered. */
  toolNames: string[];
  /** Whether the client requested streaming. */
  streaming: boolean;
  /** Normalized JSON body — useful for prompt_hash computation. */
  rawBody: unknown;
}

// ---------------------------------------------------------------------------
// Match result
// ---------------------------------------------------------------------------

export type MatchOutcome =
  | { kind: "fixture"; fixture: MockLlmFixture; score: number }
  | { kind: "synth"; reason: string }
  | { kind: "error"; reason: string };
