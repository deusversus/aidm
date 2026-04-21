import { describe, expect, it } from "vitest";
import { RuleLibraryCategory, RuleLibraryYamlFile } from "../rule-library";

describe("rule-library Zod types", () => {
  it("accepts all canonical categories", () => {
    const cats = [
      "dna",
      "composition",
      "power_tier",
      "archetype",
      "scale",
      "ceremony",
      "genre",
      "tension",
      "op_expression",
      "beat_craft",
    ];
    for (const c of cats) {
      expect(RuleLibraryCategory.parse(c)).toBe(c);
    }
  });

  it("rejects unknown categories", () => {
    expect(() => RuleLibraryCategory.parse("nonsense")).toThrow();
  });

  it("RuleLibraryYamlFile validates a well-formed DNA file shape", () => {
    const parsed = RuleLibraryYamlFile.parse({
      library_slug: "dna_heroism",
      category: "dna",
      axis: "heroism",
      entries: [
        {
          value_key: "7",
          tags: ["mid_heroism"],
          content: "Heroism at 7 leans toward earnest action...",
        },
      ],
    });
    expect(parsed.library_slug).toBe("dna_heroism");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.tags).toContain("mid_heroism");
  });

  it("allows null axis for non-axis categories (power_tier, archetype)", () => {
    const parsed = RuleLibraryYamlFile.parse({
      library_slug: "power_tier_all",
      category: "power_tier",
      axis: null,
      entries: [{ value_key: "T5", content: "Tier 5 narration guidance." }],
    });
    expect(parsed.axis).toBe(null);
  });

  it("defaults tags to [] and retrieve_conditions to {}", () => {
    const parsed = RuleLibraryYamlFile.parse({
      library_slug: "x",
      category: "dna",
      axis: "scope",
      entries: [{ value_key: "5", content: "x" }],
    });
    expect(parsed.entries[0]?.tags).toEqual([]);
    expect(parsed.entries[0]?.retrieve_conditions).toEqual({});
  });

  it("requires at least one entry per file", () => {
    expect(() =>
      RuleLibraryYamlFile.parse({
        library_slug: "x",
        category: "dna",
        axis: "scope",
        entries: [],
      }),
    ).toThrow();
  });

  it("rejects entries with empty content", () => {
    expect(() =>
      RuleLibraryYamlFile.parse({
        library_slug: "x",
        category: "dna",
        axis: "scope",
        entries: [{ value_key: "5", content: "" }],
      }),
    ).toThrow();
  });
});
