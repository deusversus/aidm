import { estimateCostUsd } from "./pricing";
import type { AnthropicMessageResponse, RequestSignature } from "./types";

/**
 * Synthetic fallback response generator (Phase A of docs/plans/mockllm.md).
 *
 * When no fixture matches a request, we synthesize a plausible response
 * instead of erroring (unless strict mode is on). The synthesis is
 * shaped by what the caller appears to want:
 *
 *   - **Structured JSON output** — when the user message contains the
 *     canonical "Return the JSON object now." directive that every
 *     `runStructuredAgent` call appends, we emit `{"type":"text",
 *     "text": "{}"}`. Agents' Zod schemas then attempt to parse; most
 *     will fail, call their fallback, and surface a typed sentinel.
 *     That's the right dev-time behavior: synth is flagged as "you
 *     need a fixture here."
 *   - **Narrative text** (KeyAnimator-shaped calls) — emit a
 *     self-identifying mock narrative so testing surfaces flag it
 *     clearly without a fixture.
 *   - **Streaming (detected via RequestSignature.streaming)** — the
 *     server module chunks the text over configurable delays.
 *
 * Token counts are derived from prompt length ÷ 4 (chars per token).
 * Good enough for cost-aware tests; fixtures override with precise
 * counts when needed.
 */

const STRUCTURED_MARKER = "Return the JSON object now";

export function appearsToWantStructuredOutput(sig: RequestSignature): boolean {
  return sig.messages.some((m) => m.role === "user" && m.text.includes(STRUCTURED_MARKER));
}

function approxInputTokens(sig: RequestSignature): number {
  const totalChars = sig.system.length + sig.messages.reduce((acc, m) => acc + m.text.length, 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}

function approxOutputTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Build a synthetic Anthropic Message response matching the provider
 * shape. Called when fixture match misses + strict mode is off.
 */
export function synthesizeAnthropicResponse(sig: RequestSignature): AnthropicMessageResponse {
  const structured = appearsToWantStructuredOutput(sig);
  const text = structured
    ? "{}"
    : `[mock narrative — model=${sig.model}, provider=${sig.provider}, messages=${sig.messages.length}]`;
  const inputTokens = approxInputTokens(sig);
  const outputTokens = approxOutputTokens(text);
  return {
    id: `msg_mock_synth_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: sig.model || "claude-mock",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

/**
 * Total USD cost of a response — read usage stats off the response,
 * look up pricing for the model, multiply.
 */
export function synthesizeCostUsd(response: AnthropicMessageResponse): number {
  return estimateCostUsd(response.model, response.usage);
}
