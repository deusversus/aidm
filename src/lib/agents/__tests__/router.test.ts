import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Router tests — verify that intents route to the correct sub-agent and
 * that the verdict shape is correct for each branch. Sub-agents are mocked
 * at the provider-SDK layer, so the router's composition logic is tested
 * without any real LLM calls.
 */

function googleReturning(text: string): () => Pick<GoogleGenAI, "models"> {
  return () =>
    ({
      models: {
        generateContent: async () => ({ text }),
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

function googleSequence(texts: string[]): () => Pick<GoogleGenAI, "models"> {
  let i = 0;
  return () =>
    ({
      models: {
        generateContent: async () => ({ text: texts[i++] ?? texts[texts.length - 1] }),
      },
    }) as unknown as Pick<GoogleGenAI, "models">;
}

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
      const google = googleReturning(
        JSON.stringify({
          intent,
          epicness: 0.3,
          special_conditions: [],
          confidence: 0.9,
        }),
      );
      const verdict = await routePlayerMessage(
        { playerMessage: "some action", canonicalityMode: "inspired" },
        { intentClassifier: { google } },
      );
      expect(verdict.kind).toBe("continue");
      expect(verdict.intent.intent).toBe(intent);
    }
  });

  it("routes WORLD_BUILDING to WorldBuilder and surfaces its decision", async () => {
    const { routePlayerMessage } = await import("../router");
    const google = googleReturning(
      JSON.stringify({
        intent: "WORLD_BUILDING",
        epicness: 0.4,
        special_conditions: [],
        confidence: 0.95,
      }),
    );
    const anthropic = anthropicReturning(
      JSON.stringify({
        decision: "ACCEPT",
        response: "It is so.",
        entityUpdates: [],
        rationale: "ok",
      }),
    );
    const verdict = await routePlayerMessage(
      {
        playerMessage: "I pull the amulet from my satchel.",
        canonicalityMode: "inspired",
      },
      { intentClassifier: { google }, worldBuilder: { anthropic } },
    );
    expect(verdict.kind).toBe("worldbuilder");
    if (verdict.kind === "worldbuilder") {
      expect(verdict.verdict.decision).toBe("ACCEPT");
    }
  });

  it("routes OVERRIDE_COMMAND to OverrideHandler in override mode", async () => {
    const { routePlayerMessage } = await import("../router");
    const google = googleSequence([
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
      { intentClassifier: { google }, overrideHandler: { google } },
    );
    expect(verdict.kind).toBe("override");
    if (verdict.kind === "override") {
      expect(verdict.override.mode).toBe("override");
      expect(verdict.override.category).toBe("NPC_PROTECTION");
    }
  });

  it("routes META_FEEDBACK to OverrideHandler in meta mode", async () => {
    const { routePlayerMessage } = await import("../router");
    const google = googleSequence([
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
      { intentClassifier: { google }, overrideHandler: { google } },
    );
    expect(verdict.kind).toBe("meta");
    if (verdict.kind === "meta") {
      expect(verdict.override.mode).toBe("meta");
    }
  });

  it("surfaces IntentClassifier fallback (DEFAULT) when classification fails hard", async () => {
    const { routePlayerMessage } = await import("../router");
    const google = () =>
      ({
        models: {
          generateContent: async () => {
            throw new Error("upstream down");
          },
        },
      }) as unknown as Pick<GoogleGenAI, "models">;
    const verdict = await routePlayerMessage(
      { playerMessage: "uncertain action", canonicalityMode: "inspired" },
      { intentClassifier: { google } },
    );
    expect(verdict.kind).toBe("continue");
    expect(verdict.intent.intent).toBe("DEFAULT");
    expect(verdict.intent.confidence).toBe(0);
  });
});
