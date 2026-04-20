import { z } from "zod";

/**
 * Universal probe-tier default.
 *
 * Probe tier is the `/api/ready` reachability check — not in the
 * creative path, not audible to the player. We keep it on Anthropic
 * Haiku across every provider because (a) it's the cheapest reliable
 * option we know, (b) conflating "LLM reachability" with "your chosen
 * provider's availability" would make reachability flap whenever a
 * specific provider hiccups. Single const imported by every provider
 * entry so a future Haiku deprecation is one edit, not four.
 */
export const PROBE_DEFAULT = "claude-haiku-4-5-20251001";

/**
 * Provider registry types.
 *
 * Each provider gets a `ProviderDefinition` describing its identity,
 * its per-tier model roster, and the feature flags downstream code
 * queries when building provider-appropriate behavior (cache shape,
 * thinking mode, MCP availability, etc.).
 *
 * This is the source of truth for "what can a user select per tier
 * when their campaign's on provider X." Campaigns validate against
 * this at write time; the settings UI reads it to populate dropdowns.
 */

export const ProviderId = z.enum(["anthropic", "google", "openai", "openrouter"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const TierName = z.enum(["probe", "fast", "thinking", "creative"]);
export type TierName = z.infer<typeof TierName>;

/**
 * Shape of a tier's model roster entry. `defaultModel` is the model
 * used when a new campaign is created on this provider and the user
 * hasn't picked a per-tier override. `selectableModels` is the full
 * list the user may choose from.
 *
 * For OpenRouter, `selectableModels` may be empty — we fall back to
 * free-form model-ID input because the OpenRouter roster moves too
 * fast to hard-enumerate. Validation is looser there.
 */
export interface TierRoster {
  defaultModel: string;
  selectableModels: readonly string[];
}

/**
 * Feature flags consumed by provider-specific KA implementations and
 * the (future) compat layer. `promptCaching` and `thinking` values
 * aren't booleans because the behavior shape differs enough per
 * provider that callers branch on the specific mechanism.
 */
export interface ProviderFeatures {
  /** True when the provider supports native MCP server integration. */
  nativeMCP: boolean;
  /**
   * How the provider exposes prompt caching:
   *   - "breakpoint": Anthropic-style cache_control marker at the boundary
   *   - "context-id": Gemini-style cache-by-ID referencing
   *   - "system-auto": OpenAI-style automatic system-prompt caching
   *   - "none": no provider-native caching
   */
  promptCaching: "breakpoint" | "context-id" | "system-auto" | "none";
  /**
   * Extended-thinking / reasoning behavior:
   *   - "adaptive": Anthropic adaptive extended thinking
   *   - "native": Gemini thinking mode
   *   - "reasoning-tokens": OpenAI o-series reasoning tokens
   *   - "none": no native thinking support
   */
  thinking: "adaptive" | "native" | "reasoning-tokens" | "none";
}

/**
 * Full definition of a provider slot in the registry.
 *
 * `available: false` means the slot exists — downstream code can
 * reference it safely — but selecting this provider for a campaign
 * should surface an actionable error ("this provider lands in M3.5")
 * rather than proceeding. That lets the settings UI render the
 * dropdown with disabled entries so users see what's coming.
 */
export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  available: boolean;
  /** Reason surfaced to the user when `available: false`. */
  unavailableReason?: string;
  tiers: Record<TierName, TierRoster>;
  features: ProviderFeatures;
  /**
   * If true, `tier_models.<tier>` is validated only to be a non-empty
   * string, not against `selectableModels`. OpenRouter uses this
   * because their roster moves too fast to hard-enumerate.
   */
  allowFreeFormModels?: boolean;
}

export const TierModels = z.object({
  probe: z.string().min(1),
  fast: z.string().min(1),
  thinking: z.string().min(1),
  creative: z.string().min(1),
});
export type TierModels = z.infer<typeof TierModels>;

export const CampaignProviderConfig = z.object({
  provider: ProviderId,
  tier_models: TierModels,
});
export type CampaignProviderConfig = z.infer<typeof CampaignProviderConfig>;
