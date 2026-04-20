import type Anthropic from "@anthropic-ai/sdk";
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
 */

function anthropicReturning(text: string): () => Pick<Anthropic, "messages"> {
  return () =>
    ({
      messages: {
        create: async () => ({
          content: [{ type: "text", text }],
        }),
      },
    }) as unknown as Pick<Anthropic, "messages">;
}

function anthropicSequence(texts: string[]): () => Pick<Anthropic, "messages"> {
  let i = 0;
  return () =>
    ({
      messages: {
        create: async () => ({
          content: [{ type: "text", text: texts[i++] ?? texts[texts.length - 1] }],
        }),
      },
    }) as unknown as Pick<Anthropic, "messages">;
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

  it("routes WORLD_BUILDING to WorldBuilder and surfaces its decision", async () => {
    const { routePlayerMessage } = await import("../router");
    // One shared anthropic fake handles both IntentClassifier's classification
    // and WorldBuilder's decision because both route through the Anthropic
    // path by default. Sequence: classification first, then WB decision.
    const anthropic = anthropicSequence([
      JSON.stringify({
        intent: "WORLD_BUILDING",
        epicness: 0.4,
        special_conditions: [],
        confidence: 0.95,
      }),
      JSON.stringify({
        decision: "ACCEPT",
        response: "It is so.",
        entityUpdates: [],
        rationale: "ok",
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
      expect(verdict.verdict.decision).toBe("ACCEPT");
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
    const anthropic = () =>
      ({
        messages: {
          create: async () => {
            throw new Error("upstream down");
          },
        },
      }) as unknown as Pick<Anthropic, "messages">;
    const verdict = await routePlayerMessage(
      { playerMessage: "uncertain action", canonicalityMode: "inspired" },
      { intentClassifier: { anthropic } },
    );
    expect(verdict.kind).toBe("continue");
    expect(verdict.intent.intent).toBe("DEFAULT");
    expect(verdict.intent.confidence).toBe(0);
  });
});
