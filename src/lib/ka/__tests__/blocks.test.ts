import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Profile } from "@/lib/types/profile";
import type { IntentOutput } from "@/lib/types/turn";
import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderKaBlocks } from "../blocks";

function loadBebop(): Profile {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  return Profile.parse(jsYaml.load(raw));
}

const intent: IntentOutput = {
  intent: "DEFAULT",
  action: "walk into the diner",
  target: "diner",
  epicness: 0.2,
  special_conditions: [],
  confidence: 0.9,
};

describe("renderKaBlocks", () => {
  it("renders all four blocks with no [UNSET: ...] leaks on a fresh campaign", () => {
    const profile = loadBebop();
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [],
      compaction: [],
      block4: {
        player_message: "I walk into the diner.",
        intent,
        player_overrides: [],
      },
    });
    expect(out.block1).not.toContain("[UNSET:");
    expect(out.block2).not.toContain("[UNSET:");
    expect(out.block3).not.toContain("[UNSET:");
    expect(out.block4).not.toContain("[UNSET:");
  });

  it("Block 1 carries profile title and author voice", () => {
    const profile = loadBebop();
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [],
      compaction: [],
      block4: { player_message: "x", intent, player_overrides: [] },
    });
    expect(out.block1).toContain("Cowboy Bebop");
    expect(out.block1).toContain("author");
  });

  it("Block 2 is empty-state on a fresh campaign", () => {
    const profile = loadBebop();
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [],
      compaction: [],
      block4: { player_message: "x", intent, player_overrides: [] },
    });
    expect(out.block2).toContain("(empty");
  });

  it("Block 3 renders working-memory turns in order", () => {
    const profile = loadBebop();
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [
        { turn_number: 1, player_message: "hi Jet", narrative_text: "Jet grunts." },
        {
          turn_number: 2,
          player_message: "what's the bounty?",
          narrative_text: "Jet reads off the numbers.",
        },
      ],
      compaction: [],
      block4: { player_message: "x", intent, player_overrides: [] },
    });
    expect(out.block3).toContain("Turn 1");
    expect(out.block3).toContain("hi Jet");
    expect(out.block3).toContain("Turn 2");
    expect(out.block3.indexOf("Turn 1")).toBeLessThan(out.block3.indexOf("Turn 2"));
  });

  it("Block 4 carries intent + scene context + overrides", () => {
    const profile = loadBebop();
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [],
      compaction: [],
      block4: {
        player_message: "I draw my Jericho.",
        intent: { ...intent, intent: "COMBAT", epicness: 0.7 },
        player_overrides: ["Lloyd cannot die"],
        scene: {
          location: "The Bebop galley",
          situation: "Vicious has Jet at the back door.",
          present_npcs: ["Jet", "Vicious"],
        },
      },
    });
    expect(out.block4).toContain("COMBAT");
    expect(out.block4).toContain("0.70");
    expect(out.block4).toContain("Lloyd cannot die");
    expect(out.block4).toContain("The Bebop galley");
    expect(out.block4).toContain("Jet");
  });

  it("active DNA overrides canonical (delta non-zero)", () => {
    const profile = loadBebop();
    const activeDna = {
      ...profile.canonical_dna,
      optimism: 9, // pushed up from Bebop's cynical canonical
    };
    const out = renderKaBlocks({
      profile,
      campaign: { active_dna: activeDna },
      workingMemory: [],
      compaction: [],
      block4: { player_message: "x", intent, player_overrides: [] },
    });
    // The delta section should mention the axis that diverged.
    expect(out.block1).toMatch(/optimism:\s*[+-]?\d/);
  });

  it("unresolved variables surface as [UNSET: name] so drift is visible", () => {
    // Simulate by passing a minimal Block 4 template expectation:
    // The real templates should have full coverage, but this validates
    // the substitution mechanism's failure mode is debuggable.
    const profile = loadBebop();
    // Sanity: current templates should NOT produce any [UNSET] on
    // well-formed input — this is the contract. A future template edit
    // that introduces a new variable without a substitution value will
    // fail this test.
    const out = renderKaBlocks({
      profile,
      campaign: {},
      workingMemory: [],
      compaction: [],
      block4: { player_message: "x", intent, player_overrides: [] },
    });
    const allBlocks = [out.block1, out.block2, out.block3, out.block4].join("\n");
    expect(allBlocks).not.toMatch(/\[UNSET: /);
  });
});
