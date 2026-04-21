import { createMockAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thin tests for Commit-5 agents. Runner behavior (retry, fallback,
 * span) is covered exhaustively in _runner.test.ts; these tests verify
 * each agent renders input/output against the right schema and returns
 * a sensible fallback.
 *
 * As of M1.5 Commit C, every consultant routes through runStructuredAgent
 * with provider dispatch from `deps.modelContext`. Tests don't pass
 * modelContext, so every call falls back to the Anthropic default —
 * inject Anthropic fakes for all tiers.
 *
 * Mocks come from `@/lib/llm/mock/testing` (Phase E of mockllm plan) —
 * the single-text helper is a thin wrapper over createMockAnthropic.
 */

// Convenience: single-text stub (consumable N times because we re-call
// fakeAnthropic per test). Runner retries up to 2× so return a seeded
// sequence of identical responses to cover both attempts.
function fakeAnthropic(text: string) {
  return createMockAnthropic([{ text }, { text }]);
}

function failingAnthropic() {
  return createMockAnthropic([{ error: new Error("upstream") }, { error: new Error("upstream") }]);
}

describe("MemoryRanker", () => {
  beforeEach(() => vi.resetModules());

  it("returns validated ranking on well-formed response", async () => {
    const { rankMemories } = await import("../memory-ranker");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        ranked: [
          { id: "m1", relevanceScore: 0.9, reason: "direct NPC match" },
          { id: "m2", relevanceScore: 0.4, reason: "background" },
        ],
        dropped: ["m3"],
      }),
    );
    const result = await rankMemories(
      {
        intent: "SOCIAL",
        playerMessage: "greet Faye",
        candidates: [
          {
            id: "m1",
            content: "Faye always smiles first",
            category: "relationship",
            heat: 80,
            baseScore: 0.7,
          },
          {
            id: "m2",
            content: "Spike is tired",
            category: "character_state",
            heat: 60,
            baseScore: 0.5,
          },
          {
            id: "m3",
            content: "the ship needs fuel",
            category: "world_state",
            heat: 40,
            baseScore: 0.3,
          },
        ],
      },
      { anthropic },
    );
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]?.id).toBe("m1");
    expect(result.dropped).toContain("m3");
  });

  it("fallback preserves embedding-score order", async () => {
    const { rankMemories } = await import("../memory-ranker");
    const result = await rankMemories(
      {
        intent: "DEFAULT",
        playerMessage: "x",
        candidates: [
          { id: "a", content: "x", category: "fact", heat: 50, baseScore: 0.8 },
          { id: "b", content: "y", category: "fact", heat: 50, baseScore: 0.6 },
        ],
      },
      { anthropic: failingAnthropic() },
    );
    expect(result.ranked.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.dropped).toEqual([]);
  });
});

describe("RecapAgent", () => {
  beforeEach(() => vi.resetModules());

  it("returns null recap when there are no prior turns (short-circuit, no provider call)", async () => {
    const { produceRecap } = await import("../recap-agent");
    let called = false;
    const anthropic = createMockAnthropic([
      {
        text: "{}",
        echo: () => {
          called = true;
        },
      },
    ]);
    const result = await produceRecap({ priorSessionTurns: [] }, { anthropic });
    expect(result.recap).toBeNull();
    expect(called).toBe(false);
  });

  it("returns recap prose from the model", async () => {
    const { produceRecap } = await import("../recap-agent");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        recap: "Spike had just walked away from Julia's message. The ship was half empty.",
        hooksMentioned: ["julia_message", "ship_status"],
      }),
    );
    const result = await produceRecap(
      { priorSessionTurns: [{ turn: 50, summary: "Spike hears Julia's recording." }] },
      { anthropic },
    );
    expect(result.recap).toContain("Spike");
    expect(result.hooksMentioned).toHaveLength(2);
  });

  it("fallback skips recap rather than surface a broken one", async () => {
    const { produceRecap } = await import("../recap-agent");
    const result = await produceRecap(
      { priorSessionTurns: [{ turn: 1, summary: "something" }] },
      { anthropic: failingAnthropic() },
    );
    expect(result.recap).toBeNull();
  });
});

describe("ScaleSelectorAgent", () => {
  beforeEach(() => vi.resetModules());

  it("returns composition mode with tension scaling", async () => {
    const { selectScale } = await import("../scale-selector-agent");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        effectiveMode: "op_dominant",
        tensionScaling: 0.25,
        rationale: "T3 vs T9 — reframe stakes",
      }),
    );
    const result = await selectScale({ attackerTier: "T3", defenderTier: "T9" }, { anthropic });
    expect(result.effectiveMode).toBe("op_dominant");
    expect(result.tensionScaling).toBeCloseTo(0.25);
  });

  it("fallback uses profile default mode with mid tension", async () => {
    const { selectScale } = await import("../scale-selector-agent");
    const result = await selectScale(
      {
        attackerTier: "T5",
        defenderTier: "T5",
        profileCompositionMode: "blended",
      },
      { anthropic: failingAnthropic() },
    );
    expect(result.effectiveMode).toBe("blended");
    expect(result.tensionScaling).toBe(0.5);
  });
});

describe("PacingAgent", () => {
  beforeEach(() => vi.resetModules());

  it("returns a beat directive with tone target", async () => {
    const { advisePacing } = await import("../pacing-agent");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        directive: "escalate",
        toneTarget: "tense",
        escalationTarget: 0.8,
        rationale: "arc calls for complication now",
      }),
    );
    const result = await advisePacing({}, { anthropic });
    expect(result.directive).toBe("escalate");
    expect(result.escalationTarget).toBeCloseTo(0.8);
  });

  it("fallback is hold-tension", async () => {
    const { advisePacing } = await import("../pacing-agent");
    const result = await advisePacing({}, { anthropic: failingAnthropic() });
    expect(result.directive).toBe("hold");
    expect(result.toneTarget).toBe("steady");
  });
});

describe("CombatAgent", () => {
  beforeEach(() => vi.resetModules());

  it("resolves a hit with facts for KA", async () => {
    const { resolveCombat } = await import("../combat-agent");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        resolution: "hit",
        damage: 4,
        resourceCost: { type: "stamina", amount: 2 },
        statusChange: ["bleeding"],
        facts: ["Spike's shot grazes Vicious's side.", "Vicious staggers but does not fall."],
        rationale: "same-tier exchange, attacker positioning advantage",
      }),
    );
    const result = await resolveCombat(
      {
        attacker: { name: "Spike", tier: "T6", abilities: ["pistol"] },
        defender: { name: "Vicious", tier: "T6", abilities: ["katana"] },
        action: "Spike fires at Vicious",
      },
      { anthropic },
    );
    expect(result.resolution).toBe("hit");
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it("fallback returns stalemate with no damage", async () => {
    const { resolveCombat } = await import("../combat-agent");
    const result = await resolveCombat(
      {
        attacker: { name: "A", tier: "T5" },
        defender: { name: "B", tier: "T5" },
        action: "strike",
      },
      { anthropic: failingAnthropic() },
    );
    expect(result.resolution).toBe("stalemate");
    expect(result.damage).toBeNull();
    expect(result.facts[0]).toContain("A");
    expect(result.facts[0]).toContain("B");
  });
});

describe("OutcomeJudge", () => {
  beforeEach(() => vi.resetModules());

  it("returns validated OutcomeOutput", async () => {
    const { judgeOutcome } = await import("../outcome-judge");
    const anthropic = fakeAnthropic(
      JSON.stringify({
        success_level: "success",
        difficulty_class: 15,
        modifiers: ["advantage: surprise"],
        narrative_weight: "SIGNIFICANT",
        consequence: "the guard will remember Spike's face",
        cost: "noise attracted attention",
        rationale: "fair test, clear success, real but survivable cost",
      }),
    );
    const result = await judgeOutcome(
      {
        intent: {
          intent: "COMBAT",
          epicness: 0.5,
          special_conditions: [],
          confidence: 0.9,
        },
        playerMessage: "I knock the guard out",
      },
      { anthropic },
    );
    expect(result.success_level).toBe("success");
    expect(result.narrative_weight).toBe("SIGNIFICANT");
  });

  it("fallback is neutral partial_success", async () => {
    const { judgeOutcome } = await import("../outcome-judge");
    const result = await judgeOutcome(
      {
        intent: {
          intent: "DEFAULT",
          epicness: 0.2,
          special_conditions: [],
          confidence: 0.9,
        },
        playerMessage: "x",
      },
      { anthropic: failingAnthropic() },
    );
    expect(result.success_level).toBe("partial_success");
    expect(result.narrative_weight).toBe("MINOR");
  });
});

describe("Validator + judgeOutcomeWithValidation", () => {
  beforeEach(() => vi.resetModules());

  it("validateOutcome passes through valid verdicts", async () => {
    const { validateOutcome } = await import("../validator");
    const anthropic = fakeAnthropic(JSON.stringify({ valid: true, correction: null }));
    const result = await validateOutcome(
      {
        intent: {
          intent: "ABILITY",
          epicness: 0.4,
          special_conditions: [],
          confidence: 0.9,
        },
        proposedOutcome: {
          success_level: "success",
          difficulty_class: 10,
          modifiers: [],
          narrative_weight: "MINOR",
          rationale: "fine",
        },
      },
      { anthropic },
    );
    expect(result.valid).toBe(true);
  });

  it("orchestrator: OJ → Validator pass-through → no retry", async () => {
    const { judgeOutcomeWithValidation } = await import("../validator");
    // Call 1: OJ verdict. Call 2: validator pass.
    const anthropic = createMockAnthropic([
      {
        text: JSON.stringify({
          success_level: "success",
          difficulty_class: 12,
          modifiers: [],
          narrative_weight: "MINOR",
          rationale: "clean",
        }),
      },
      { text: JSON.stringify({ valid: true, correction: null }) },
    ]);

    const result = await judgeOutcomeWithValidation(
      {
        intent: {
          intent: "DEFAULT",
          epicness: 0.2,
          special_conditions: [],
          confidence: 0.9,
        },
        playerMessage: "x",
      },
      {},
      { anthropic },
    );
    expect(result.retried).toBe(false);
    expect(result.outcome.success_level).toBe("success");
    expect(result.validator.valid).toBe(true);
    // Consumed exactly OJ + validator (2 of 2 prepared responses).
  });

  it("orchestrator: Validator rejects → OJ retries with correction → returns second verdict", async () => {
    const { judgeOutcomeWithValidation } = await import("../validator");
    let call = 0;
    // Call 1: OJ first pass. Call 2: validator rejects. Call 3: OJ retry. Call 4: validator OK.
    const anthropic = createMockAnthropic([
      {
        text: JSON.stringify({
          success_level: "critical_success",
          difficulty_class: 30,
          modifiers: [],
          narrative_weight: "CLIMACTIC",
          rationale: "first pass — too generous",
        }),
        echo: () => {
          call += 1;
        },
      },
      {
        text: JSON.stringify({
          valid: false,
          correction: "OP-mode stakes should be framed on cost, not survival",
        }),
        echo: () => {
          call += 1;
        },
      },
      {
        text: JSON.stringify({
          success_level: "success",
          difficulty_class: 18,
          modifiers: [],
          narrative_weight: "SIGNIFICANT",
          cost: "Spike's tell becomes visible",
          rationale: "reweighted toward cost per validator",
        }),
        echo: () => {
          call += 1;
        },
      },
      {
        text: JSON.stringify({ valid: true, correction: null }),
        echo: () => {
          call += 1;
        },
      },
    ]);

    const result = await judgeOutcomeWithValidation(
      {
        intent: {
          intent: "COMBAT",
          epicness: 0.9,
          special_conditions: [],
          confidence: 0.95,
        },
        playerMessage: "I strike down the challenger",
      },
      { compositionMode: "op_dominant" },
      { anthropic },
    );
    expect(result.retried).toBe(true);
    expect(result.outcome.success_level).toBe("success");
    expect(result.outcome.cost).toContain("Spike");
    expect(call).toBe(4);
  });
});
