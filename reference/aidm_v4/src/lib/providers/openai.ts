import { PROBE_DEFAULT, type ProviderDefinition } from "./types";

/**
 * OpenAI provider — stub until OpenAI-KA lands at M5.5.
 *
 * Roster is intentionally empty. The user has not yet supplied the
 * specific OpenAI model IDs they want selectable (per the user-picks-
 * models rule). When M5.5 approaches, ask the user for the GPT roster
 * the same way we sourced the Anthropic and Google shortlists.
 *
 * `available: false` and an empty `selectableModels` mean attempting
 * to create a campaign on OpenAI at M1.5 surfaces an actionable error.
 *
 * OpenAI-KA doubles as the OpenRouter shim at M5.5 (same HTTP surface,
 * different base URL).
 */

export const openai: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  available: false,
  unavailableReason: "OpenAI-KA lands at M5.5. Currently available: Anthropic.",
  tiers: {
    probe: {
      defaultModel: PROBE_DEFAULT,
      selectableModels: [PROBE_DEFAULT],
    },
    fast: { defaultModel: "", selectableModels: [] },
    thinking: { defaultModel: "", selectableModels: [] },
    creative: { defaultModel: "", selectableModels: [] },
  },
  features: {
    nativeMCP: false,
    promptCaching: "system-auto",
    thinking: "reasoning-tokens",
  },
};
