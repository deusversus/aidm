import { env } from "@/lib/env";
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | undefined;

/** Anthropic client singleton. Lazy so module import never touches env. */
export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Reset the cached client — test-only. */
export function resetAnthropicClientForTesting(): void {
  _client = undefined;
}

// Infrastructure-ping default only. The player-facing tier menus
// (narration/judgment/probe, blueprint §3) land in C4 as lib/llm/tiers.ts;
// callers with a campaign context must never read from here.
const PROBE_MODEL = "claude-haiku-4-5";

/**
 * Minimal-cost reachability probe: 1 input token, 1 output token on the
 * cheapest probe-menu model. Returns true if the call completes within
 * `timeoutMs`. Never throws.
 */
export async function pingAnthropic(timeoutMs = 3000): Promise<boolean> {
  if (!env.ANTHROPIC_API_KEY) return false;
  try {
    const client = getAnthropic();
    await client.messages.create(
      {
        model: PROBE_MODEL,
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
