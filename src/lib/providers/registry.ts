import { anthropic } from "./anthropic";
import { google } from "./google";
import { openai } from "./openai";
import { openrouter } from "./openrouter";
import {
  CampaignProviderConfig,
  type ProviderDefinition,
  type ProviderId,
  type TierModels,
  type TierName,
} from "./types";

/**
 * Provider registry — source of truth for "what providers exist, what
 * models are selectable per tier per provider, and what features each
 * provider supports." Consumed by:
 *   - Campaign schema validation (rejects tier_models that don't fit)
 *   - Settings UI (populates dropdowns)
 *   - KA dispatch (picks the right per-provider implementation)
 *   - Compat layer at M6.5 (queries features to graceful-degrade)
 *
 * At M1.5 only Anthropic is `available: true`; the other three slots
 * exist to keep downstream code provider-agnostic (no "if google"
 * special cases elsewhere) and to let the settings UI render "coming
 * soon" states with real unavailableReason strings.
 */

const REGISTRY: Record<ProviderId, ProviderDefinition> = {
  anthropic,
  google,
  openai,
  openrouter,
};

export function getProvider(id: ProviderId): ProviderDefinition {
  return REGISTRY[id];
}

export function listProviders(): ProviderDefinition[] {
  return Object.values(REGISTRY);
}

export function listAvailableProviders(): ProviderDefinition[] {
  return listProviders().filter((p) => p.available);
}

/**
 * Default tier_models for a given provider — what a new campaign on
 * that provider gets when the user hasn't picked overrides.
 */
export function defaultTierModelsFor(id: ProviderId): TierModels {
  const provider = getProvider(id);
  return {
    probe: provider.tiers.probe.defaultModel,
    fast: provider.tiers.fast.defaultModel,
    thinking: provider.tiers.thinking.defaultModel,
    creative: provider.tiers.creative.defaultModel,
  };
}

export class CampaignProviderValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CampaignProviderValidationError";
    this.code = code;
  }
}

/**
 * Validate a campaign's provider + tier_models against the registry.
 * Throws `CampaignProviderValidationError` on any problem:
 *   - Unknown provider id (shouldn't happen after Zod but defense-in-depth)
 *   - Provider is not `available`
 *   - A tier's model isn't in the provider's `selectableModels`
 *     (unless `allowFreeFormModels` is true, in which case only
 *     non-empty is required)
 *
 * Callers wrap this in a try/catch and surface the message to the UI
 * or return it from Server Actions — it's user-facing.
 */
export function validateCampaignProviderConfig(config: unknown): void {
  // Zod-parse defensively: callers handing in un-parsed JSON from
  // Server Actions or DB reads would otherwise crash with a raw
  // TypeError on missing tier_models. Surface every shape violation
  // as CampaignProviderValidationError so consumers catch cleanly.
  const parseResult = CampaignProviderConfig.safeParse(config);
  if (!parseResult.success) {
    throw new CampaignProviderValidationError(
      `Malformed campaign provider config: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
      "malformed_config",
    );
  }
  const parsed = parseResult.data;
  const provider = REGISTRY[parsed.provider];
  if (!provider) {
    throw new CampaignProviderValidationError(
      `Unknown provider: ${parsed.provider}`,
      "unknown_provider",
    );
  }
  if (!provider.available) {
    throw new CampaignProviderValidationError(
      provider.unavailableReason ?? `${provider.displayName} is not yet available.`,
      "provider_unavailable",
    );
  }
  const tiers: TierName[] = ["probe", "fast", "thinking", "creative"];
  for (const tier of tiers) {
    const picked = parsed.tier_models[tier];
    if (!picked) {
      throw new CampaignProviderValidationError(
        `tier_models.${tier} is required`,
        "missing_tier_model",
      );
    }
    if (provider.allowFreeFormModels) continue;
    const selectable = provider.tiers[tier].selectableModels;
    if (!selectable.includes(picked)) {
      throw new CampaignProviderValidationError(
        `${provider.displayName} does not offer "${picked}" on the ${tier} tier. Available: ${selectable.join(", ") || "(none yet)"}.`,
        "model_not_in_roster",
      );
    }
  }
}

/**
 * Known-safe default for callers that don't yet have a campaign
 * context (scripts, `/api/ready`, tests, new-campaign seed). Always
 * returns Anthropic's defaults — mirrors `anthropicDefaults` in
 * env.ts (M1.5 Commit E renames env's `tiers` to that name for
 * clarity). Keeping this accessor here means the env.ts import is
 * one-way (env → providers → callers) and not circular.
 */
export function anthropicFallbackConfig(): CampaignProviderConfig {
  return {
    provider: "anthropic",
    tier_models: defaultTierModelsFor("anthropic"),
  };
}
