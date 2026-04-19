import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeAnthropic(
  responses: Array<{ text?: string; error?: unknown }>,
): () => Pick<Anthropic, "messages"> {
  let i = 0;
  return () =>
    ({
      messages: {
        create: async () => {
          const next = responses[i++];
          if (!next) throw new Error("no more mock responses");
          if (next.error) throw next.error;
          return {
            content: [{ type: "text", text: next.text ?? "" }],
          };
        },
      },
    }) as unknown as Pick<Anthropic, "messages">;
}

describe("validateAssertion (WorldBuilder)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ACCEPT when the model accepts the assertion", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          decision: "ACCEPT",
          response:
            "Your hand finds the worn leather of the satchel, and there — tucked behind the folded map — is the amulet.",
          entityUpdates: [
            { kind: "item", name: "grandmother's amulet", details: "silver, tarnished" },
          ],
          rationale: "Consistent with inherited-heirloom trope; same-tier assertion.",
        }),
      },
    ]);
    const result = await validateAssertion(
      {
        assertion: "I reach into my satchel and pull out the amulet my grandmother gave me.",
        canonicalityMode: "inspired",
      },
      { anthropic },
    );
    expect(result.decision).toBe("ACCEPT");
    expect(result.entityUpdates).toHaveLength(1);
    expect(result.response).toContain("amulet");
  });

  it("returns CLARIFY with in-character dialogue", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          decision: "CLARIFY",
          response: "Tell me more — when did you see it last?",
          entityUpdates: [],
          rationale: "Ambiguous timeline; asking player to anchor the claim.",
        }),
      },
    ]);
    const result = await validateAssertion(
      { assertion: "I remember now — I always had the scroll.", canonicalityMode: "full_cast" },
      { anthropic },
    );
    expect(result.decision).toBe("CLARIFY");
    expect(result.response).toContain("?");
  });

  it("returns REJECT with in-character prose, never a modal", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          decision: "REJECT",
          response:
            "The satchel is lighter than you remember. The amulet isn't there, and you know, with the cold certainty of memory, that you left it behind in the village.",
          entityUpdates: [],
          rationale: "Canonically absent in full_cast mode.",
        }),
      },
    ]);
    const result = await validateAssertion(
      {
        assertion: "I produce a dragon egg from my pocket.",
        canonicalityMode: "full_cast",
      },
      { anthropic },
    );
    expect(result.decision).toBe("REJECT");
    expect(result.response).not.toMatch(/error|rejected|invalid/i);
  });

  it("handles markdown fence wrapping", async () => {
    const { validateAssertion } = await import("../world-builder");
    const body = JSON.stringify({
      decision: "ACCEPT",
      response: "OK",
      entityUpdates: [],
      rationale: "fenced",
    });
    const anthropic = fakeAnthropic([{ text: `\`\`\`json\n${body}\n\`\`\`` }]);
    const result = await validateAssertion(
      { assertion: "trivial assertion", canonicalityMode: "inspired" },
      { anthropic },
    );
    expect(result.decision).toBe("ACCEPT");
  });

  it("retries once on malformed JSON, then recovers", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      { text: "not json" },
      {
        text: JSON.stringify({
          decision: "ACCEPT",
          response: "OK",
          entityUpdates: [],
          rationale: "recovered",
        }),
      },
    ]);
    const result = await validateAssertion(
      { assertion: "x", canonicalityMode: "inspired" },
      { anthropic },
    );
    expect(result.decision).toBe("ACCEPT");
  });

  it("falls back to CLARIFY with in-character prose after retry budget", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([{ text: "garbage" }, { text: "still garbage" }]);
    const result = await validateAssertion(
      { assertion: "x", canonicalityMode: "inspired" },
      { anthropic },
    );
    expect(result.decision).toBe("CLARIFY");
    expect(result.response).not.toMatch(/error|failed|sorry/i);
  });

  it("falls back to CLARIFY on network errors", async () => {
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      { error: new Error("timeout") },
      { error: new Error("timeout") },
    ]);
    const result = await validateAssertion(
      { assertion: "x", canonicalityMode: "inspired" },
      { anthropic },
    );
    expect(result.decision).toBe("CLARIFY");
  });
});
