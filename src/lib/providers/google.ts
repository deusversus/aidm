import type { ProviderDefinition } from "./types";

/**
 * Google provider — stub until Google-KA lands at M3.5.
 *
 * The roster is the user-confirmed 2026-04-19 list of valid Gemini IDs:
 *   - gemini-3.1-flash-lite-preview (cheapest flash; fast-tier fit)
 *   - gemini-3-flash-preview (standard flash; mid)
 *   - gemini-3.1-pro-preview (pro tier; thinking/creative fit)
 *
 * `available: false` — selecting Google as a campaign provider at M1.5
 * surfaces an actionable error. The registry slot exists so the
 * settings UI can render "Google (coming M3.5)" as a disabled option,
 * and downstream code (schema validation, dispatch) can reference the
 * provider safely without a special case.
 *
 * When M3.5 lands, this file populates per-tier rosters, flips
 * `available: true`, and the Google-KA plugs into dispatch.ts. No
 * other code should change.
 */

export const GOOGLE_ROSTER: readonly string[] = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
];

export const google: ProviderDefinition = {
  id: "google",
  displayName: "Google",
  available: false,
  unavailableReason: "Google-KA (Gemini-native) lands at M3.5. Currently available: Anthropic.",
  tiers: {
    probe: {
      // Probe stays Haiku universally until revisited per-provider.
      // Kept here so the shape is consistent; not used while Google
      // is unavailable.
      defaultModel: "claude-haiku-4-5-20251001",
      selectableModels: ["claude-haiku-4-5-20251001"],
    },
    fast: {
      defaultModel: "gemini-3.1-flash-lite-preview",
      selectableModels: GOOGLE_ROSTER,
    },
    thinking: {
      defaultModel: "gemini-3.1-pro-preview",
      selectableModels: GOOGLE_ROSTER,
    },
    creative: {
      defaultModel: "gemini-3.1-pro-preview",
      selectableModels: GOOGLE_ROSTER,
    },
  },
  features: {
    nativeMCP: false,
    promptCaching: "context-id",
    thinking: "native",
  },
};
