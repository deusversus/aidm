import { createMockAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Router tests — verify that intents route to the correct sub-agent and
 * that the verdict shape is correct for each branch. Sub-agents are
 * mocked at the provider-SDK layer, so the router's composition logic
 * is tested without any real LLM calls.
 *
 * As of M1.5 Commit C, every consultant routes through
 * runStructuredAgent with provider dispatch from `deps.modelContext`.
 * Tests don't pass modelContext here, so everything falls back to the
 * Anthropic default — inject Anthropic fakes throughout.
 *
 * Mocks via unified helper (Phase E of mockllm plan). The router makes
 * one structured call per turn (IntentClassifier), sometimes followed
 * by OverrideHandler / WorldBuilder calls — response sequence accounts
 * for that by padding with duplicates where call count varies.
 */

function anthropicReturning(text: string) {
  // Single-text for tests making one call; pad to 4 for safety against
  // retry paths.
  return createMockAnthropic([{ text }, { text }, { text }, { text }]);
}

function anthropicSequence(texts: string[]) {
  return createMockAnthropic(texts.map((text) => ({ text })));
}

describe("routePlayerMessage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("routes DEFAULT / COMBAT / SOCIAL / EXPLORATION / ABILITY / INVENTORY / OP_COMMAND to `continue`", async () => {
    const { routePlayerMessage } = await import("../router");
    const intents = [
      "DEFAULT",
      "COMBAT",
      "SOCIAL",
      "EXPLORATION",
      "ABILITY",
      "INVENTORY",
      "OP_COMMAND",
    ] as const;
    for (const intent of intents) {
      const anthropic = anthropicReturning(
        JSON.stringify({
          intent,
          epicness: 0.3,
          special_conditions: [],
          confidence: 0.9,
        }),
      );
      const verdict = await routePlayerMessage(
        { playerMessage: "some action", canonicalityMode: "inspired" },
        { intentClassifier: { anthropic } },
      );
      expect(verdict.kind).toBe("continue");
      expect(verdict.intent.intent).toBe(intent);
    }
  });

  it("WB ACCEPT returns continue with wbAssertion (WB reshape — no short-circuit)", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "WORLD_BUILDING",
        epicness: 0.4,
        special_conditions: [],
        confidence: 0.95,
      }),
      JSON.stringify({
        decision: "ACCEPT",
        response: "The amulet settles in your palm.",
        entityUpdates: [
          { kind: "item", name: "grandmother's amulet", description: "silver, tarnished" },
        ],
        flags: [],
        rationale: "Extends prior canon; no craft concern.",
      }),
    ]);
    const verdict = await routePlayerMessage(
      {
        playerMessage: "I pull the amulet from my satchel.",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { anthropic }, worldBuilder: { anthropic } },
    );
    expect(verdict.kind).toBe("continue");
    if (verdict.kind === "continue") {
      expect(verdict.wbAssertion).toBeDefined();
      expect(verdict.wbAssertion?.decision).toBe("ACCEPT");
      expect(verdict.wbAssertion?.entityUpdates).toHaveLength(1);
      expect(verdict.wbAssertion?.flags).toEqual([]);
    }
  });

  it("WB FLAG returns continue with wbAssertion + typed flags", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "WORLD_BUILDING",
        epicness: 0.5,
        special_conditions: [],
        confidence: 0.9,
      }),
      JSON.stringify({
        decision: "FLAG",
        response: "Noted.",
        entityUpdates: [],
        flags: [
          {
            kind: "voice_fit",
            evidence: "galactic-empire scale in a grounded noir",
            suggestion: "consider implying the scope off-screen",
          },
        ],
        rationale: "Scale mismatch with the premise; surfacing as voice_fit.",
      }),
    ]);
    const verdict = await routePlayerMessage(
      {
        playerMessage: "The galactic empire has existed for 10,000 years.",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { anthropic }, worldBuilder: { anthropic } },
    );
    expect(verdict.kind).toBe("continue");
    if (verdict.kind === "continue") {
      expect(verdict.wbAssertion?.decision).toBe("FLAG");
      expect(verdict.wbAssertion?.flags).toHaveLength(1);
      expect(verdict.wbAssertion?.flags[0]?.kind).toBe("voice_fit");
    }
  });

  it("WB CLARIFY returns worldbuilder kind (still short-circuits for physical ambiguity)", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "WORLD_BUILDING",
        epicness: 0.3,
        special_conditions: [],
        confidence: 0.88,
      }),
      JSON.stringify({
        decision: "CLARIFY",
        response: "You reach, but the satchel feels emptier than expected. When did you stow it?",
        entityUpdates: [],
        flags: [],
        rationale: "Scene established satchel as empty; assertion conflicts.",
      }),
    ]);
    const verdict = await routePlayerMessage(
      {
        playerMessage: "I pull the amulet from my satchel.",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { anthropic }, worldBuilder: { anthropic } },
    );
    expect(verdict.kind).toBe("worldbuilder");
    if (verdict.kind === "worldbuilder") {
      expect(verdict.verdict.decision).toBe("CLARIFY");
      expect(verdict.verdict.response).toContain("?");
    }
  });

  it("routes OVERRIDE_COMMAND to OverrideHandler in override mode", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "OVERRIDE_COMMAND",
        epicness: 0.0,
        special_conditions: [],
        confidence: 0.99,
      }),
      JSON.stringify({
        mode: "override",
        category: "NPC_PROTECTION",
        value: "Lloyd cannot die",
        scope: "campaign",
        conflicts_with: [],
        ack_phrasing: "Noted.",
      }),
    ]);
    const verdict = await routePlayerMessage(
      {
        playerMessage: "/override Lloyd cannot die",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { anthropic }, overrideHandler: { anthropic } },
    );
    expect(verdict.kind).toBe("override");
    if (verdict.kind === "override") {
      expect(verdict.override.mode).toBe("override");
      expect(verdict.override.category).toBe("NPC_PROTECTION");
    }
  });

  it("routes META_FEEDBACK to OverrideHandler in meta mode", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "META_FEEDBACK",
        epicness: 0.0,
        special_conditions: [],
        confidence: 0.99,
      }),
      JSON.stringify({
        mode: "meta",
        category: null,
        value: "less torture",
        scope: "campaign",
        conflicts_with: [],
        ack_phrasing: "Heard.",
      }),
    ]);
    const verdict = await routePlayerMessage(
      {
        playerMessage: "/meta less torture please",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { anthropic }, overrideHandler: { anthropic } },
    );
    expect(verdict.kind).toBe("meta");
    if (verdict.kind === "meta") {
      expect(verdict.override.mode).toBe("meta");
    }
  });

  it("surfaces IntentClassifier fallback (DEFAULT) when classification fails hard", async () => {
    const { routePlayerMessage } = await import("../router");
    const anthropic = createMockAnthropic([
      { error: new Error("upstream down") },
      { error: new Error("upstream down") },
    ]);
    const verdict = await routePlayerMessage(
      { playerMessage: "uncertain action", canonicalityMode: "inspired" },
      { intentClassifier: { anthropic } },
    );
    expect(verdict.kind).toBe("continue");
    expect(verdict.intent.intent).toBe("DEFAULT");
    expect(verdict.intent.confidence).toBe(0);
  });
});
