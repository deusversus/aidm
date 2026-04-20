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

  const existingParsed = CampaignSettings.safeParse(existingSettings ?? {});
  const existing = existingParsed.success ? (existingParsed.data as Record<string, unknown>) : {};

  return {
    ...existing,
    provider: configParsed.data.provider,
    tier_models: configParsed.data.tier_models,
  };
}
