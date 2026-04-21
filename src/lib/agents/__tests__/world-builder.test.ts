import { createMockAnthropic as fakeAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Anthropic client stub via the unified helper — same signature
// as the inline fakeAnthropic that used to live here; aliased so the
// call-site diff is zero. Phase E of mockllm plan.

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

  it("returns FLAG with accepting in-character prose + a craft concern (Phase 6B reshape)", async () => {
    // v4 WB reshape (Phase 6B): REJECT is gone. Player assertions that
    // would have been rejected in v3 now surface as FLAG — accepted at
    // the fiction layer, with a craft advisory for Director/Chronicler.
    const { validateAssertion } = await import("../world-builder");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          decision: "FLAG",
          response:
            "You pull out the dragon egg and for a moment Spike stares. It's the size of your palm, rough as volcanic stone. He doesn't ask where it came from.",
          entityUpdates: [
            { kind: "item", name: "Dragon egg", description: "palm-sized, volcanic-rough" },
          ],
          flags: [
            {
              concern:
                "Introduces a dragon-tier artifact into Cowboy Bebop's grounded-noir register; may compress tonal consistency.",
              severity: "worth_watching",
            },
          ],
          rationale: "Accepted per editor-not-gatekeeper posture; craft flag for Director review.",
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
    expect(result.decision).toBe("FLAG");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]?.severity).toBe("worth_watching");
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
