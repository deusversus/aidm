import type { IntentOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import {
  STYLE_DRIFT_POOL,
  detectStaleConstructions,
  pickStyleDrift,
  renderStyleDriftDirective,
  renderVocabFreshnessAdvisory,
} from "../diversity";

function intent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    intent: "DEFAULT",
    epicness: 0.3,
    special_conditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("pickStyleDrift", () => {
  it("returns null when last 3 narrations already show opening variety", () => {
    const picked = pickStyleDrift({
      recentNarrations: [
        '"Get up," Jet said.', // dialogue
        "Spike stumbled to the galley.", // pronoun_action
        "The Bebop creaked as it entered atmosphere.", // descriptor
      ],
      intent: intent(),
      narrativeWeight: "MINOR",
      recentlyUsed: [],
      random: () => 0,
    });
    expect(picked).toBeNull();
  });

  it("picks a directive when recent openings converge", () => {
    const picked = pickStyleDrift({
      recentNarrations: [
        "Spike walked away.",
        "Spike lit a cigarette.",
        "Spike stared at the ceiling.",
      ],
      intent: intent(),
      narrativeWeight: "MINOR",
      recentlyUsed: [],
      random: () => 0,
    });
    expect(picked).not.toBeNull();
    expect(STYLE_DRIFT_POOL).toContain(picked);
  });

  it("excludes 'open with dialogue' for COMBAT intent", () => {
    const picked = pickStyleDrift({
      recentNarrations: ["Spike drew.", "Spike fired.", "Spike dodged."],
      intent: intent({ intent: "COMBAT" }),
      narrativeWeight: "SIGNIFICANT",
      recentlyUsed: [],
      random: () => 0,
    });
    expect(picked).not.toBe("open with dialogue");
  });

  it("excludes 'try environmental POV' on CLIMACTIC beats", () => {
    // Pin random to index 1 which would be env-POV in base pool;
    // filter should skip it.
    const picked = pickStyleDrift({
      recentNarrations: ["Line one.", "Line two.", "Line three."],
      intent: intent(),
      narrativeWeight: "CLIMACTIC",
      recentlyUsed: [],
      random: () => 0,
    });
    expect(picked).not.toBe("try environmental POV");
  });

  it("excludes recently-used directives", () => {
    const picked = pickStyleDrift({
      recentNarrations: ["a", "b", "c"],
      intent: intent(),
      narrativeWeight: "MINOR",
      recentlyUsed: ["cold open", "fragment the beat into short cuts"],
      random: () => 0,
    });
    expect(picked).not.toBe("cold open");
    expect(picked).not.toBe("fragment the beat into short cuts");
  });

  it("returns null when all candidates are disallowed", () => {
    const picked = pickStyleDrift({
      recentNarrations: ["a", "b", "c"],
      intent: intent({ intent: "COMBAT" }),
      narrativeWeight: "CLIMACTIC",
      recentlyUsed: [...STYLE_DRIFT_POOL],
      random: () => 0,
    });
    expect(picked).toBeNull();
  });
});

describe("detectStaleConstructions", () => {
  it("flags simile pattern repeated 3+ times", () => {
    const narrations = [
      "He moved like a cat on tile.",
      "She spoke like a hammer on glass.",
      "The engine growled like an angry bear.",
    ];
    const flagged = detectStaleConstructions({ recentNarrations: narrations });
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]?.pattern).toContain("simile");
  });

  it("does not flag below threshold", () => {
    const narrations = ["He moved like a cat."];
    const flagged = detectStaleConstructions({ recentNarrations: narrations });
    expect(flagged).toEqual([]);
  });

  it("returns empty when no patterns match", () => {
    const narrations = [
      "The room was quiet. The lights hummed. Jet set down his tea.",
      "Nothing else happened that evening worth recording.",
    ];
    expect(detectStaleConstructions({ recentNarrations: narrations })).toEqual([]);
  });

  it("respects repeatThreshold override", () => {
    const narrations = ["like a cat", "like a dog"];
    const flagged = detectStaleConstructions({
      recentNarrations: narrations,
      repeatThreshold: 2,
    });
    expect(flagged.length).toBeGreaterThan(0);
  });
});

describe("renderers", () => {
  it("style drift empty → empty string", () => {
    expect(renderStyleDriftDirective(null)).toBe("");
  });

  it("style drift non-empty → advisory block", () => {
    const out = renderStyleDriftDirective("cold open");
    expect(out).toContain("Style drift");
    expect(out).toContain("cold open");
  });

  it("vocab freshness empty → empty string", () => {
    expect(renderVocabFreshnessAdvisory([])).toBe("");
  });

  it("vocab freshness non-empty → advisory block with examples", () => {
    const out = renderVocabFreshnessAdvisory([
      { pattern: "simile_like_a", examples: ["like a cat"], count: 4 },
    ]);
    expect(out).toContain("Vocabulary freshness");
    expect(out).toContain("simile_like_a");
    expect(out).toContain("4×");
  });
});
