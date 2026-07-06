import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_DEFAULTS,
  ANTHROPIC_ROSTER,
  CampaignProviderValidationError,
  anthropicFallbackConfig,
  defaultTierModelsFor,
  getProvider,
  listAvailableProviders,
  listProviders,
  validateCampaignProviderConfig,
} from "../index";

describe("provider registry", () => {
  describe("listProviders / listAvailableProviders", () => {
    it("returns all four provider slots", () => {
      const ids = listProviders()
        .map((p) => p.id)
        .sort();
      expect(ids).toEqual(["anthropic", "google", "openai", "openrouter"]);
    });

    it("only Anthropic is available at M1.5", () => {
      const available = listAvailableProviders().map((p) => p.id);
      expect(available).toEqual(["anthropic"]);
    });

    it("unavailable providers carry an actionable reason", () => {
      const google = getProvider("google");
      expect(google.available).toBe(false);
      expect(google.unavailableReason).toMatch(/M3\.5/);
      const openai = getProvider("openai");
      expect(openai.unavailableReason).toMatch(/M5\.5/);
      const openrouter = getProvider("openrouter");
      expect(openrouter.unavailableReason).toMatch(/M5\.5/);
    });
  });

  describe("Anthropic roster", () => {
    it("includes current latest + dated snapshots", () => {
      expect(ANTHROPIC_ROSTER).toContain("claude-opus-4-7");
      expect(ANTHROPIC_ROSTER).toContain("claude-sonnet-4-6");
      expect(ANTHROPIC_ROSTER).toContain("claude-haiku-4-5-20251001");
      expect(ANTHROPIC_ROSTER).toContain("claude-opus-4-5-20251101");
      expect(ANTHROPIC_ROSTER).toContain("claude-opus-4-1-20250805");
      expect(ANTHROPIC_ROSTER).toContain("claude-3-haiku-20240307");
    });

    it("full roster is selectable on fast / thinking / creative tiers", () => {
      const provider = getProvider("anthropic");
      for (const tier of ["fast", "thinking", "creative"] as const) {
        expect(provider.tiers[tier].selectableModels).toEqual(ANTHROPIC_ROSTER);
      }
    });

    it("probe tier is Haiku-only", () => {
      const provider = getProvider("anthropic");
      expect(provider.tiers.probe.selectableModels).toEqual(["claude-haiku-4-5-20251001"]);
    });

    it("defaults match ANTHROPIC_DEFAULTS", () => {
      expect(defaultTierModelsFor("anthropic")).toEqual(ANTHROPIC_DEFAULTS);
    });

    it("features declare native MCP + breakpoint caching + adaptive thinking", () => {
      const provider = getProvider("anthropic");
      expect(provider.features).toEqual({
        nativeMCP: true,
        promptCaching: "breakpoint",
        thinking: "adaptive",
      });
    });
  });

  describe("Google roster (stub at M1.5)", () => {
    it("populated with three user-confirmed Gemini IDs", () => {
      const provider = getProvider("google");
      expect(provider.tiers.fast.selectableModels).toEqual([
        "gemini-3.1-flash-lite-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-pro-preview",
      ]);
    });

    it("features declare no-MCP + context-id caching + native thinking", () => {
      const provider = getProvider("google");
      expect(provider.features).toEqual({
        nativeMCP: false,
        promptCaching: "context-id",
        thinking: "native",
      });
    });
  });

  describe("OpenRouter", () => {
    it("allows free-form models", () => {
      const provider = getProvider("openrouter");
      expect(provider.allowFreeFormModels).toBe(true);
    });
  });

  describe("validateCampaignProviderConfig", () => {
    it("accepts a well-formed Anthropic config", () => {
      expect(() =>
        validateCampaignProviderConfig({
          provider: "anthropic",
          tier_models: {
            probe: "claude-haiku-4-5-20251001",
            fast: "claude-haiku-4-5-20251001",
            thinking: "claude-opus-4-7",
            creative: "claude-opus-4-7",
          },
        }),
      ).not.toThrow();
    });

    it("accepts snapshot selection on creative tier", () => {
      expect(() =>
        validateCampaignProviderConfig({
          provider: "anthropic",
          tier_models: {
            probe: "claude-haiku-4-5-20251001",
            fast: "claude-haiku-4-5-20251001",
            thinking: "claude-opus-4-5-20251101",
            creative: "claude-opus-4-5-20251101",
          },
        }),
      ).not.toThrow();
    });

    it("rejects non-Haiku model on probe tier", () => {
      expect(() =>
        validateCampaignProviderConfig({
          provider: "anthropic",
          tier_models: {
            probe: "claude-opus-4-7",
            fast: "claude-haiku-4-5-20251001",
            thinking: "claude-opus-4-7",
            creative: "claude-opus-4-7",
          },
        }),
      ).toThrow(CampaignProviderValidationError);
    });

    it("rejects Google at M1.5 with the unavailable reason", () => {
      try {
        validateCampaignProviderConfig({
          provider: "google",
          tier_models: {
            probe: "claude-haiku-4-5-20251001",
            fast: "gemini-3.1-flash-lite-preview",
            thinking: "gemini-3.1-pro-preview",
            creative: "gemini-3.1-pro-preview",
          },
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignProviderValidationError);
        expect((err as CampaignProviderValidationError).code).toBe("provider_unavailable");
        expect((err as Error).message).toMatch(/M3\.5/);
      }
    });

    it("rejects model not in Anthropic's selectable roster", () => {
      try {
        validateCampaignProviderConfig({
          provider: "anthropic",
          tier_models: {
            probe: "claude-haiku-4-5-20251001",
            fast: "claude-haiku-4-5-20251001",
            thinking: "claude-opus-99-fake",
            creative: "claude-opus-4-7",
          },
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignProviderValidationError);
        expect((err as CampaignProviderValidationError).code).toBe("model_not_in_roster");
      }
    });
  });

  describe("malformed-config defensive parse", () => {
    it("rejects completely malformed input with malformed_config code", () => {
      try {
        validateCampaignProviderConfig({ garbage: true });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignProviderValidationError);
        expect((err as CampaignProviderValidationError).code).toBe("malformed_config");
      }
    });

    it("rejects missing tier_models without raw TypeError", () => {
      try {
        validateCampaignProviderConfig({ provider: "anthropic" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignProviderValidationError);
        expect((err as CampaignProviderValidationError).code).toBe("malformed_config");
      }
    });

    it("rejects case-mismatched provider id", () => {
      try {
        validateCampaignProviderConfig({
          provider: "Anthropic",
          tier_models: {
            probe: "claude-haiku-4-5-20251001",
            fast: "claude-haiku-4-5-20251001",
            thinking: "claude-opus-4-7",
            creative: "claude-opus-4-7",
          },
        });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CampaignProviderValidationError);
        expect((err as CampaignProviderValidationError).code).toBe("malformed_config");
      }
    });
  });

  describe("anthropicFallbackConfig", () => {
    it("returns a valid Anthropic config matching defaults", () => {
      const config = anthropicFallbackConfig();
      expect(config.provider).toBe("anthropic");
      expect(config.tier_models).toEqual(ANTHROPIC_DEFAULTS);
      expect(() => validateCampaignProviderConfig(config)).not.toThrow();
    });
  });
});
