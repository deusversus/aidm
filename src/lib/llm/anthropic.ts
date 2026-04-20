import { anthropicDefaults, env } from "@/lib/env";
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  _client = new Anthropic({ apiKey });
  return _client;
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
