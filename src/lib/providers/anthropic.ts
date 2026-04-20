import type { ProviderDefinition } from "./types";

/**
 * Anthropic provider definition.
 *
 * The roster is the user-confirmed 2026-04-20 shortlist: current
 * "latest" models (Opus 4.7, Sonnet 4.6, Haiku 4.5) plus dated
 * snapshots for writers who want voice consistency against a
 * specific trained behavior (Opus 4.6 / 4.5 / 4.1 / 4.0 / Sonnet 4.5
 * / 4.0 / claude-3-haiku). All selectable for all non-probe tiers —
 * per the "user selects models per tier" rule, we enumerate what's
 * selectable; the user picks.
 *
 * Some combinations are incoherent at runtime:
 *   - Haiku on the thinking tier: extended-thinking budget is
 *     ignored because Haiku doesn't support extended thinking.
 *   - claude-3-haiku on structured-output tiers: older model,
 *     weaker schema adherence; more retries, more fallbacks.
 * These are soft warnings in the settings UI (M1.5 Commit F),
 * never hard-validation blocks. User agency absolute.
 *
 * Probe tier is Haiku-only. Probe is for `/api/ready` reachability;
 * cheap + reliable + not in the creative path.
 */

const LATEST_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

const SNAPSHOTS = [
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307",
] as const;

export const ANTHROPIC_ROSTER: readonly string[] = [...LATEST_MODELS, ...SNAPSHOTS];

/**
 * Defaults used when a new campaign is created on Anthropic and the
 * user hasn't picked per-tier overrides.
 *
 * Note the semantic shift from env.ts's global `tiers` table: there,
 * `fast` tier is Gemini Flash-Lite (cross-provider routing to cheap
 * Google inference). Under per-campaign provider scoping, fast tier
 * follows the campaign's provider — so an Anthropic campaign's fast
 * tier is Haiku, not Gemini. The old cross-provider routing for fast
 * consultants returns at M6.5 as an opt-in per-consultant override
 * (see ROADMAP §7.7 compat layer). Existing campaigns keep their
 * picks when defaults shift; only new campaigns prefill from here.
 */
export const ANTHROPIC_DEFAULTS = {
  probe: "claude-haiku-4-5-20251001",
  fast: "claude-haiku-4-5-20251001",
  thinking: "claude-opus-4-7",
  creative: "claude-opus-4-7",
} as const;

export const anthropic: ProviderDefinition = {
  id: "anthropic",
  displayName: "Anthropic",
  available: true,
  tiers: {
    probe: {
      defaultModel: ANTHROPIC_DEFAULTS.probe,
      selectableModels: ["claude-haiku-4-5-20251001"],
    },
    fast: {
      defaultModel: ANTHROPIC_DEFAULTS.fast,
      selectableModels: ANTHROPIC_ROSTER,
    },
    thinking: {
      defaultModel: ANTHROPIC_DEFAULTS.thinking,
      selectableModels: ANTHROPIC_ROSTER,
    },
    creative: {
      defaultModel: ANTHROPIC_DEFAULTS.creative,
      selectableModels: ANTHROPIC_ROSTER,
    },
  },
  features: {
    nativeMCP: true,
    promptCaching: "breakpoint",
    thinking: "adaptive",
  },
};
