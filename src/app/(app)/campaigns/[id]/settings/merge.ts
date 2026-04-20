import {
  CampaignProviderConfig,
  CampaignProviderValidationError,
  validateCampaignProviderConfig,
} from "@/lib/providers";
import { CampaignSettings } from "@/lib/types/campaign-settings";

/**
 * Merge a new provider config onto an existing settings blob without
 * clobbering unrelated fields (active_dna, world_state, overrides,
 * voice_patterns, director_notes, arc_plan, canon_rules).
 *
 * Lives in its own module because Next.js `"use server"` files in
 * `actions.ts` are restricted to async-exports only — a sync helper
 * would fail the Server Actions build check. Keeping this pure and
 * sync means it's trivially unit-testable and can be used anywhere
 * (not just the Server Action boundary).
 *
 * Returns the new settings object or throws `CampaignProviderValidationError`
 * when the config is malformed / targets an unavailable provider /
 * picks a model not in the provider's roster.
 */
export function mergeSettingsWithProviderConfig(
  existingSettings: unknown,
  providerConfigInput: unknown,
): Record<string, unknown> {
  const configParsed = CampaignProviderConfig.safeParse(providerConfigInput);
  if (!configParsed.success) {
    throw new CampaignProviderValidationError(
      `Malformed provider config: ${configParsed.error.issues.map((i) => i.message).join("; ")}`,
      "malformed_config",
    );
  }
  validateCampaignProviderConfig(configParsed.data); // throws on invalid

  // Passthrough existing settings when parse succeeds. When it fails
  // (one corrupted field taints the whole blob under safeParse), fall
  // back to the RAW existing object cast to Record so we don't wipe
  // 95% of a campaign's state (active_dna, world_state, voice_patterns,
  // etc.) just because a single legacy field doesn't match the current
  // schema. The provider/tier_models overwrite still wins. Empty-object
  // only when existingSettings is genuinely null/undefined/not-an-object.
  const existingParsed = CampaignSettings.safeParse(existingSettings ?? {});
  const existing: Record<string, unknown> = existingParsed.success
    ? (existingParsed.data as Record<string, unknown>)
    : existingSettings && typeof existingSettings === "object"
      ? (existingSettings as Record<string, unknown>)
      : {};

  return {
    ...existing,
    provider: configParsed.data.provider,
    tier_models: configParsed.data.tier_models,
  };
}
