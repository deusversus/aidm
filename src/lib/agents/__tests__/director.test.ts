import { createMockAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Director lives on the thinking tier — mock Anthropic to exercise the
 * happy path + fallback without hitting the network. The shape of the
 * output matters more than the content; KA's Block 1 renders the
 * voice_patterns journal verbatim and the memory writer persists the
 * rest.
 *
 * Mocks via unified helper (Phase E of mockllm plan).
 */

function fakeAnthropic(text: string) {
  // Runner retries once on parse failure — seed two responses.
  return createMockAnthropic([{ text }, { text }]);
}

function failingAnthropic() {
  return createMockAnthropic([{ error: new Error("upstream") }, { error: new Error("upstream") }]);
}

const VALID_OUTPUT = JSON.stringify({
  arcPlan: {
    current_arc: "Syndicate closing in",
    arc_phase: "complication",
    arc_mode: "main_arc",
    arc_pov_protagonist: null,
    arc_transition_signal: "Spike is confronted in a public place",
    tension_level: 0.7,
    planned_beats: ["Faye picks up a lead", "Jet warns Spike", "Vicious makes a move"],
  },
  foreshadowing: {
    plant: [
      {
        name: "mystery courier",
        description: "A stranger delivers a sealed package to Jet",
        payoff_window_min: 3,
        payoff_window_max: 10,
      },
    ],
    retire: [],
  },
  spotlightDebt: { per_npc: { faye: -2, jet: 1 } },
  voicePatterns: {
    patterns: ["terse two-sentence openings", "ash-and-neon imagery before mood shifts"],
  },
  directorNotes: ["keep Faye in the frame this session"],
  rationale: "Arc is building toward direct confrontation; Faye needs screen time.",
});

describe("Director", () => {
  beforeEach(() => vi.resetModules());

  it("parses a well-formed response", async () => {
    const { runDirector } = await import("../director");
    const result = await runDirector(
      { trigger: "startup", openingStatePackage: { foo: "bar" } },
      { anthropic: fakeAnthropic(VALID_OUTPUT) },
    );
    expect(result.arcPlan.current_arc).toBe("Syndicate closing in");
    expect(result.voicePatterns.patterns).toHaveLength(2);
    expect(result.foreshadowing.plant).toHaveLength(1);
  });

  it("falls back to empty journal + neutral arc when upstream fails", async () => {
    const { runDirector } = await import("../director");
    const result = await runDirector(
      { trigger: "session_boundary" },
      { anthropic: failingAnthropic() },
    );
    expect(result.voicePatterns.patterns).toEqual([]);
    expect(result.foreshadowing.plant).toEqual([]);
    expect(result.arcPlan.planned_beats.length).toBeGreaterThan(0);
    expect(result.rationale).toMatch(/fallback/i);
  });

  it("renderVoicePatternsJournal returns empty string for empty patterns", async () => {
    const { renderVoicePatternsJournal } = await import("../director");
    expect(renderVoicePatternsJournal([])).toBe("");
  });

  it("renderVoicePatternsJournal formats patterns as a bulleted list", async () => {
    const { renderVoicePatternsJournal } = await import("../director");
    const out = renderVoicePatternsJournal(["terse openings", "weather-as-mood"]);
    expect(out).toContain("The player has responded to:");
    expect(out).toContain("- terse openings");
    expect(out).toContain("- weather-as-mood");
  });
});
