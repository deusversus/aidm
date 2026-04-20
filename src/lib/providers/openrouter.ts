import type { ProviderDefinition } from "./types";

/**
 * OpenRouter provider — stub until M5.5.
 *
 * OpenRouter is the escape hatch: any model not in the Big 3's
 * bounded rosters (sunset Anthropic snapshots after Anthropic
 * deprecates them, DeepSeek / Qwen / Mistral, Groq / Cerebras cheap
 * inference, experimental releases) is reachable through OpenRouter's
 * OpenAI-compatible HTTP surface.
 *
 * `allowFreeFormModels: true` — unlike the Big 3, we don't hard-
 * enumerate OpenRouter's roster because it moves too fast. Users
 * type an exact OpenRouter model ID; we validate it's non-empty
 * and that's it. Bad IDs surface as runtime errors from OpenRouter,
 * not as validation blocks at save time.
 *
 * Lands at M5.5 as a thin shim over OpenAI-KA. See ROADMAP §7.7.
 */

export const openrouter: ProviderDefinition = {
  id: "openrouter",
  displayName: "OpenRouter",
  available: false,
  unavailableReason:
    "OpenRouter (thin shim over OpenAI-KA) lands at M5.5. Currently available: Anthropic.",
  tiers: {
    probe: {
      defaultModel: "claude-haiku-4-5-20251001",
      selectableModels: ["claude-haiku-4-5-20251001"],
    },
    fast: { defaultModel: "", selectableModels: [] },
    thinking: { defaultModel: "", selectableModels: [] },
    creative: { defaultModel: "", selectableModels: [] },
  },
  features: {
    nativeMCP: false,
    promptCaching: "none",
    thinking: "none",
  },
  allowFreeFormModels: true,
};
