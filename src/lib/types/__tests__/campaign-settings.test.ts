import { describe, expect, it } from "vitest";
import { CampaignSettings, hasProviderConfig } from "../campaign-settings";

describe("CampaignSettings", () => {
  it("parses an empty settings blob (pre-migration legacy row)", () => {
    const parsed = CampaignSettings.parse({});
    expect(parsed).toEqual({});
    expect(hasProviderConfig(parsed)).toBe(false);
  });

  it("parses a post-M1-seed settings blob without provider fields (legacy shape)", () => {
    const legacy = {
      active_dna: { violence: 6, humor: 4 },
      active_composition: { scope: "ensemble" },
      world_state: {
        location: "Somewhere",
        present_npcs: ["Alice", "Bob"],
      },
      overrides: [],
    };
    const parsed = CampaignSettings.parse(legacy);
    expect(parsed.world_state?.location).toBe("Somewhere");
    expect(parsed.world_state?.present_npcs).toEqual(["Alice", "Bob"]);
    expect(hasProviderConfig(parsed)).toBe(false);
  });

  it("parses an M1.5-era settings blob WITH provider + tier_models", () => {
    const modern = {
      active_dna: {},
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-7",
        creative: "claude-opus-4-7",
      },
    };
    const parsed = CampaignSettings.parse(modern);
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.tier_models?.creative).toBe("claude-opus-4-7");
    expect(hasProviderConfig(parsed)).toBe(true);
  });

  it("passthrough preserves unknown fields so forward-compat rows aren't lost", () => {
    const withExtras = {
      active_dna: {},
      // fields a hypothetical later milestone adds:
      some_future_field: { nested: { deep: true } },
    };
    const parsed = CampaignSettings.parse(withExtras) as Record<string, unknown>;
    expect(parsed.some_future_field).toEqual({ nested: { deep: true } });
  });

  it("validates override shape when present", () => {
    const withOverrides = {
      overrides: [
        {
          id: "o1",
          category: "NPC_PROTECTION",
          value: "Lloyd cannot die",
          scope: "campaign",
          created_at: "2026-04-19T00:00:00Z",
        },
      ],
    };
    const parsed = CampaignSettings.parse(withOverrides);
    expect(parsed.overrides).toHaveLength(1);
    expect(parsed.overrides?.[0]?.category).toBe("NPC_PROTECTION");
  });

  it("rejects invalid override category", () => {
    const bad = {
      overrides: [{ id: "o1", category: "NONSENSE", value: "x" }],
    };
    expect(() => CampaignSettings.parse(bad)).toThrow();
  });

  it("half-migrated row (provider without tier_models) parses but fails hasProviderConfig", () => {
    const half = { provider: "anthropic" as const };
    const parsed = CampaignSettings.parse(half);
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.tier_models).toBeUndefined();
    expect(hasProviderConfig(parsed)).toBe(false);
  });

  it("malformed tier_models (missing tier) fails parse — migration will skip the row", () => {
    const malformed = {
      provider: "anthropic" as const,
      tier_models: { probe: "claude-haiku-4-5-20251001" },
    };
    expect(() => CampaignSettings.parse(malformed)).toThrow();
  });

  it("rejects invalid provider value", () => {
    const bad = {
      provider: "NotARealProvider",
      tier_models: {
        probe: "x",
        fast: "x",
        thinking: "x",
        creative: "x",
      },
    };
    expect(() => CampaignSettings.parse(bad)).toThrow();
  });
});
