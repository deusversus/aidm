import { CampaignProviderValidationError } from "@/lib/providers";
import { describe, expect, it } from "vitest";
import { mergeSettingsWithProviderConfig } from "../merge";

/**
 * Pure-function tests for the settings-merge helper. The Server Action
 * wrapping it (auth + DB) is integration-shaped; this is where the
 * interesting business logic lives, so it's where the tests live.
 */

const validAnthropicConfig = {
  provider: "anthropic" as const,
  tier_models: {
    probe: "claude-haiku-4-5-20251001",
    fast: "claude-haiku-4-5-20251001",
    thinking: "claude-opus-4-7",
    creative: "claude-opus-4-7",
  },
};

describe("mergeSettingsWithProviderConfig", () => {
  it("preserves unrelated settings fields when merging a new config", () => {
    const existing = {
      active_dna: { violence: 7 },
      world_state: { location: "The Bebop", present_npcs: ["Jet", "Faye"] },
      overrides: [
        {
          id: "o1",
          category: "NPC_PROTECTION" as const,
          value: "Lloyd cannot die",
          scope: "campaign" as const,
        },
      ],
      voice_patterns: { patterns: ["terse openings"] },
      // Pre-migration: no provider/tier_models yet.
    };
    const next = mergeSettingsWithProviderConfig(existing, validAnthropicConfig);
    expect(next.active_dna).toEqual({ violence: 7 });
    expect(next.world_state).toEqual({ location: "The Bebop", present_npcs: ["Jet", "Faye"] });
    expect(next.overrides).toHaveLength(1);
    expect(next.voice_patterns).toEqual({ patterns: ["terse openings"] });
    expect(next.provider).toBe("anthropic");
    expect(next.tier_models).toEqual(validAnthropicConfig.tier_models);
  });

  it("overwrites existing provider + tier_models (campaign is swapping models)", () => {
    const existing = {
      provider: "anthropic",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-7",
        creative: "claude-opus-4-7",
      },
      world_state: { location: "Somewhere" },
    };
    const nextConfig = {
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101", // snapshot pin
        creative: "claude-sonnet-4-6", // cost-down
      },
    };
    const next = mergeSettingsWithProviderConfig(existing, nextConfig);
    expect(next.tier_models).toEqual(nextConfig.tier_models);
    expect(next.world_state).toEqual({ location: "Somewhere" }); // preserved
  });

  it("tolerates an empty existing-settings blob", () => {
    const next = mergeSettingsWithProviderConfig({}, validAnthropicConfig);
    expect(next.provider).toBe("anthropic");
    expect(next.tier_models).toEqual(validAnthropicConfig.tier_models);
  });

  it("tolerates null/undefined existing-settings (falls back to empty object)", () => {
    const next = mergeSettingsWithProviderConfig(null, validAnthropicConfig);
    expect(next.provider).toBe("anthropic");
  });

  it("throws malformed_config on shape-invalid input", () => {
    try {
      mergeSettingsWithProviderConfig({}, { provider: "anthropic" }); // missing tier_models
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignProviderValidationError);
      expect((err as CampaignProviderValidationError).code).toBe("malformed_config");
    }
  });

  it("throws provider_unavailable when targeting a not-yet-built provider (Google at M1.5)", () => {
    const googleConfig = {
      provider: "google" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    try {
      mergeSettingsWithProviderConfig({}, googleConfig);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignProviderValidationError);
      expect((err as CampaignProviderValidationError).code).toBe("provider_unavailable");
    }
  });

  it("throws model_not_in_roster when a tier picks a model the provider doesn't offer", () => {
    const bogus = {
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-99-fake",
        creative: "claude-opus-4-7",
      },
    };
    try {
      mergeSettingsWithProviderConfig({}, bogus);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignProviderValidationError);
      expect((err as CampaignProviderValidationError).code).toBe("model_not_in_roster");
    }
  });

  it("passes through raw existing when CampaignSettings.parse fails (don't amplify one bad field into mass wipe)", () => {
    // `overrides: "not-an-array"` taints CampaignSettings.parse. Under
    // the stricter prior behavior this would wipe every OTHER field.
    // Under the current safer passthrough, all other fields survive.
    const corrupt = {
      active_dna: { violence: 7 }, // valid
      world_state: { location: "Mars" }, // valid
      overrides: "not-an-array", // INVALID — taints the whole parse
      voice_patterns: { patterns: ["terse"] }, // valid
    };
    const next = mergeSettingsWithProviderConfig(corrupt, validAnthropicConfig);
    expect(next.provider).toBe("anthropic");
    expect(next.tier_models).toEqual(validAnthropicConfig.tier_models);
    // Unrelated valid fields survive despite the failing parse.
    expect(next.active_dna).toEqual({ violence: 7 });
    expect(next.world_state).toEqual({ location: "Mars" });
    expect(next.voice_patterns).toEqual({ patterns: ["terse"] });
    // The corrupted field itself is passed through unchanged — we're
    // not validating OR repairing existing state; just adding
    // provider + tier_models on top of whatever's there.
    expect(next.overrides).toBe("not-an-array");
  });
});
