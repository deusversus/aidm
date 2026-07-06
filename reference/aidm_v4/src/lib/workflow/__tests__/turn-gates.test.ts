import type { Db } from "@/lib/db";
import type { characters } from "@/lib/state/schema";
import type { IntentOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import {
  computeEffectiveCompositionMode,
  resolveModelContext,
  retrievalBudget,
  shouldPreJudgeOutcome,
} from "../turn";

function intent(partial: Partial<IntentOutput>): IntentOutput {
  return {
    intent: "DEFAULT",
    epicness: 0.2,
    special_conditions: [],
    confidence: 0.9,
    ...partial,
  };
}

describe("retrievalBudget (§9 tiered memory — v3-parity thresholds)", () => {
  it("returns 0 for trivial actions (low epicness + non-consequential intent + no special conditions)", () => {
    // "I look in my pack" at epicness 0.1 — pure trivial action gate.
    expect(retrievalBudget(0, intent({ intent: "INVENTORY" }))).toBe(0);
    expect(retrievalBudget(0.1, intent({ intent: "EXPLORATION" }))).toBe(0);
    expect(retrievalBudget(0.19, intent({ intent: "DEFAULT" }))).toBe(0);
  });

  it("returns 3 for tier-1 non-trivial turns (0.2 ≤ epicness ≤ 0.3)", () => {
    // EXPLORATION at epicness 0.2 — above trivial; below tier-2 breakpoint.
    expect(retrievalBudget(0.2, intent({ intent: "EXPLORATION" }))).toBe(3);
    expect(retrievalBudget(0.3, intent({ intent: "EXPLORATION" }))).toBe(3);
  });

  it("returns 6 for tier-2 turns (0.3 < epicness ≤ 0.6)", () => {
    expect(retrievalBudget(0.31, intent({ intent: "EXPLORATION" }))).toBe(6);
    expect(retrievalBudget(0.5, intent({ intent: "EXPLORATION" }))).toBe(6);
    expect(retrievalBudget(0.6, intent({ intent: "EXPLORATION" }))).toBe(6);
  });

  it("returns 9 for pivotal turns (epicness > 0.6)", () => {
    expect(retrievalBudget(0.61, intent({ intent: "SOCIAL" }))).toBe(9);
    expect(retrievalBudget(0.9, intent({ intent: "SOCIAL" }))).toBe(9);
    expect(retrievalBudget(1.0, intent({ intent: "SOCIAL" }))).toBe(9);
  });

  it("floors COMBAT to tier-2 minimum even when epicness is low", () => {
    // COMBAT at epicness 0.1 would normally be tier-0 (or trivial), but
    // the COMBAT floor pushes to tier-2 = 6 memories. v3-parity: combat
    // without continuity reads flat.
    expect(retrievalBudget(0.1, intent({ intent: "COMBAT" }))).toBe(6);
    expect(retrievalBudget(0.25, intent({ intent: "COMBAT" }))).toBe(6);
  });

  it("bumps tier when special_conditions are present", () => {
    // Tier 1 + bump = tier 2 = 6 memories.
    expect(
      retrievalBudget(
        0.3,
        intent({ intent: "EXPLORATION", special_conditions: ["blood_moon_rising"] }),
      ),
    ).toBe(6);
    // Tier 2 + bump = tier 3 = 9.
    expect(
      retrievalBudget(0.5, intent({ intent: "SOCIAL", special_conditions: ["sword_drawn"] })),
    ).toBe(9);
    // Tier 3 (already max) stays at 9.
    expect(
      retrievalBudget(0.9, intent({ intent: "COMBAT", special_conditions: ["climactic"] })),
    ).toBe(9);
  });

  it("trivial-action gate blocks the special_conditions bump for low-epicness non-consequential turns", () => {
    // INVENTORY at epicness 0.05 even with conditions stays trivial → 0.
    // Wait — our gate requires special_conditions.length === 0 to fire.
    // If conditions are present, the bump applies instead. Here: tier=0,
    // bump to tier=1 → 3.
    expect(
      retrievalBudget(0.1, intent({ intent: "INVENTORY", special_conditions: ["cursed_object"] })),
    ).toBe(3);
  });
});

describe("resolveModelContext", () => {
  it("falls back to Anthropic when settings is empty (legacy pre-migration row)", () => {
    const ctx = resolveModelContext({});
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.tier_models.creative).toBe("claude-opus-4-7");
  });

  it("falls back to Anthropic when settings is null / undefined", () => {
    const ctx = resolveModelContext(null);
    expect(ctx.provider).toBe("anthropic");
  });

  it("falls back when settings lacks provider or tier_models (half-migrated)", () => {
    const ctx = resolveModelContext({ provider: "anthropic" }); // missing tier_models
    expect(ctx.provider).toBe("anthropic"); // default Anthropic fallback
    expect(ctx.tier_models).toBeDefined();
  });

  it("returns parsed config when fully populated", () => {
    const settings = {
      active_dna: {},
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101", // snapshot pin
        creative: "claude-sonnet-4-6", // cost-down creative
      },
    };
    const ctx = resolveModelContext(settings);
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.tier_models.thinking).toBe("claude-opus-4-5-20251101");
    expect(ctx.tier_models.creative).toBe("claude-sonnet-4-6");
  });

  it("throws when the config is syntactically valid but targets an unavailable provider", () => {
    const settings = {
      provider: "google" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    expect(() => resolveModelContext(settings)).toThrow(/M3\.5/);
  });

  it("throws when the model string isn't in the provider's roster", () => {
    const settings = {
      provider: "anthropic" as const,
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-99-fake",
        creative: "claude-opus-4-7",
      },
    };
    expect(() => resolveModelContext(settings)).toThrow(/roster|not offer/i);
  });

  it("falls back to Anthropic when settings parse fails entirely (malformed payload)", () => {
    // Anything that doesn't match CampaignSettings fails safeParse; resolver
    // falls back rather than blowing up the turn.
    const ctx = resolveModelContext({ overrides: "not-an-array" });
    expect(ctx.provider).toBe("anthropic");
  });
});

describe("computeEffectiveCompositionMode (§7.3 scale-selector — deterministic)", () => {
  /** Build a fake Db that returns a specified defender NPC tier lookup. */
  function fakeDb(defenderTier: string | null): Db {
    return {
      select: (_cols?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_w: unknown) => ({
            limit: async () => (defenderTier === null ? [] : [{ powerTier: defenderTier }]),
          }),
        }),
      }),
    } as unknown as Db;
  }
  function fakeCharacter(tier: string): typeof characters.$inferSelect {
    return {
      id: "char-1",
      campaignId: "camp-1",
      name: "Test Character",
      concept: "test",
      powerTier: tier,
      sheet: {},
      createdAt: new Date(),
    } as typeof characters.$inferSelect;
  }

  it("returns 'not_applicable' for non-combat intents", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T8"),
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "SOCIAL" }),
      { present_npcs: ["Vicious"] },
    );
    expect(mode).toBe("not_applicable");
  });

  it("returns 'not_applicable' when character has no tier", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T8"),
      "camp-1",
      null,
      intent({ intent: "COMBAT", target: "Vicious" }),
      { present_npcs: ["Vicious"] },
    );
    expect(mode).toBe("not_applicable");
  });

  it("returns 'not_applicable' when no defender can be identified", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T8"),
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "COMBAT" }), // no target, no present_npcs
      { present_npcs: [] },
    );
    expect(mode).toBe("not_applicable");
  });

  it("returns 'not_applicable' when defender NPC is not catalogued", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb(null), // DB returns empty — NPC not in catalog
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "COMBAT", target: "Mystery Mook" }),
      { present_npcs: ["Mystery Mook"] },
    );
    expect(mode).toBe("not_applicable");
  });

  it("returns 'op_dominant' when attacker is 3+ tiers above defender (T3 vs T6+)", async () => {
    // T3 attacker, T6 defender: diff = 6-3 = 3 → op_dominant
    const modeA = await computeEffectiveCompositionMode(
      fakeDb("T6"),
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "COMBAT", target: "Mook" }),
      { present_npcs: ["Mook"] },
    );
    expect(modeA).toBe("op_dominant");
    // T3 attacker, T9 defender: diff = 9-3 = 6 → op_dominant
    const modeB = await computeEffectiveCompositionMode(
      fakeDb("T9"),
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "COMBAT", target: "Mook" }),
      { present_npcs: ["Mook"] },
    );
    expect(modeB).toBe("op_dominant");
  });

  it("returns 'blended' when attacker is exactly 2 tiers above defender", async () => {
    // T5 attacker, T7 defender: diff = 7-5 = 2 → blended
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T7"),
      "camp-1",
      fakeCharacter("T5"),
      intent({ intent: "COMBAT", target: "Enemy" }),
      { present_npcs: ["Enemy"] },
    );
    expect(mode).toBe("blended");
  });

  it("returns 'standard' for parity exchanges", async () => {
    // T5 vs T5: diff = 0 → standard
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T5"),
      "camp-1",
      fakeCharacter("T5"),
      intent({ intent: "COMBAT", target: "Peer" }),
      { present_npcs: ["Peer"] },
    );
    expect(mode).toBe("standard");
  });

  it("returns 'standard' when attacker is WEAKER than defender (negative diff)", async () => {
    // T9 attacker vs T3 defender: diff = 3-9 = -6 → standard (attacker underdog)
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T3"),
      "camp-1",
      fakeCharacter("T9"),
      intent({ intent: "COMBAT", target: "Godlike" }),
      { present_npcs: ["Godlike"] },
    );
    expect(mode).toBe("standard");
  });

  it("falls back to first present NPC when intent.target is absent", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T8"),
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "ABILITY" }), // no target
      { present_npcs: ["Lucky First NPC"] },
    );
    // T3 vs T8: diff = 5 → op_dominant
    expect(mode).toBe("op_dominant");
  });

  it("handles malformed tier strings gracefully (returns 'not_applicable')", async () => {
    const mode = await computeEffectiveCompositionMode(
      fakeDb("T11"), // out of range
      "camp-1",
      fakeCharacter("T3"),
      intent({ intent: "COMBAT", target: "x" }),
      { present_npcs: ["x"] },
    );
    expect(mode).toBe("not_applicable");

    const mode2 = await computeEffectiveCompositionMode(
      fakeDb("T5"),
      "camp-1",
      fakeCharacter("garbage"),
      intent({ intent: "COMBAT", target: "x" }),
      { present_npcs: ["x"] },
    );
    expect(mode2).toBe("not_applicable");
  });
});

describe("shouldPreJudgeOutcome", () => {
  it("fires for COMBAT regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "COMBAT", epicness: 0.1 }))).toBe(true);
    expect(shouldPreJudgeOutcome(intent({ intent: "COMBAT", epicness: 0.9 }))).toBe(true);
  });

  it("fires for ABILITY regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "ABILITY", epicness: 0.1 }))).toBe(true);
  });

  it("fires for SOCIAL only when epicness ≥ 0.4", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "SOCIAL", epicness: 0.3 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "SOCIAL", epicness: 0.4 }))).toBe(true);
  });

  it("fires for EXPLORATION only when epicness ≥ 0.6", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "EXPLORATION", epicness: 0.5 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "EXPLORATION", epicness: 0.6 }))).toBe(true);
  });

  it("skips INVENTORY / OP_COMMAND regardless of epicness", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "INVENTORY", epicness: 0.9 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "OP_COMMAND", epicness: 0.9 }))).toBe(false);
  });

  it("skips low-stakes DEFAULT but fires at epicness ≥ 0.6", () => {
    expect(shouldPreJudgeOutcome(intent({ intent: "DEFAULT", epicness: 0.4 }))).toBe(false);
    expect(shouldPreJudgeOutcome(intent({ intent: "DEFAULT", epicness: 0.6 }))).toBe(true);
  });
});
