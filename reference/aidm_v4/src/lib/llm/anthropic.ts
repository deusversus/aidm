import { anthropicDefaults, env } from "@/lib/env";
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | undefined;

/**
 * Anthropic client singleton. When `AIDM_MOCK_LLM=1` the baseURL is
 * redirected to the local mock server (docs/plans/mockllm.md Phase B),
 * and the API key requirement is relaxed — the mock doesn't validate
 * keys. This lets `pnpm dev` + integration tests run with zero real
 * API calls.
 *
 * MOCKLLM_HOST / MOCKLLM_PORT override the default `127.0.0.1:7777`
 * target. CI + dev scripts set these env vars; production unsets them.
 */
export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const mockMode = process.env.AIDM_MOCK_LLM === "1";
  if (mockMode) {
    const host = process.env.MOCKLLM_HOST ?? "127.0.0.1";
    const port = process.env.MOCKLLM_PORT ?? "7777";
    _client = new Anthropic({
      apiKey: "mock-key",
      baseURL: `http://${host}:${port}`,
    });
    return _client;
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Reset the cached client — test-only. Callers that mutate
 * AIDM_MOCK_LLM between test groups need this to pick up the new env.
 */
export function resetAnthropicClientForTesting(): void {
  _client = undefined;
}

/**
 * Minimal-cost reachability probe. Uses the `probe` tier (Haiku 4.5), 1 input
 * token, 1 output token. Returns true if the call completes within
 * `timeoutMs`. Never throws.
 */
export async function pingAnthropic(timeoutMs = 3000): Promise<boolean> {
  if (!env.ANTHROPIC_API_KEY) return false;
  try {
    const client = getAnthropic();
    await client.messages.create(
      {
        model: anthropicDefaults.probe,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}
