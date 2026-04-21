import { describe, expect, it } from "vitest";
import { getPrompt } from "..";

/**
 * Prompt-eval harness (Phase 7 polish — MINOR #22). Structural tests
 * that pin key regressions:
 *   - Block 4 exposes the slots the turn workflow writes into.
 *   - Each structured-output agent includes the contract fragment.
 *   - Load-bearing Chronicler + WB tool-use mentions stay present.
 *
 * Lightweight (string includes + fragment-membership); not a full
 * LLM eval. Runs in &lt;100ms; catches silent prompt drift that
 * fingerprint-diff alone would miss because a rephrased section can
 * change fingerprint but keep traits intact.
 */

describe("prompt structure — Block 4 variable slots", () => {
  const block4 = getPrompt("ka/block_4_dynamic").content;
  it("has the per-turn variables turn.ts writes", () => {
    const expected = [
      "{{intent_type}}",
      "{{intent_action}}",
      "{{outcome_verdict}}",
      "{{active_composition_mode}}",
      "{{retrieval_budget}}",
      "{{player_overrides}}",
      "{{arc_phase}}",
      "{{arc_phase_craft}}",
      "{{active_foreshadowing}}",
      "{{director_notes}}",
      "{{sakuga_injection}}",
      "{{style_drift_directive}}",
      "{{vocabulary_freshness_advisory}}",
    ];
    for (const slot of expected) {
      expect(block4, `missing slot ${slot}`).toContain(slot);
    }
  });
});

describe("prompt structure — Block 1 + Block 2 slots", () => {
  it("Block 1 exposes active_tonal_state, dna_delta, rule-library slot", () => {
    const b1 = getPrompt("ka/block_1_ambient").content;
    expect(b1).toContain("{{active_tonal_state}}");
    expect(b1).toContain("{{dna_delta}}");
    expect(b1).toContain("{{session_rule_library_guidance}}");
    expect(b1).toContain("{{voice_patterns_journal}}");
  });
  it("Block 2 exposes session_context_blocks + compaction_entries", () => {
    const b2 = getPrompt("ka/block_2_compaction").content;
    expect(b2).toContain("{{session_context_blocks}}");
    expect(b2).toContain("{{compaction_entries}}");
  });
});

describe("prompt structure — structured-output contract inclusion", () => {
  const agents = [
    "agents/intent-classifier",
    "agents/override-handler",
    "agents/world-builder",
    "agents/outcome-judge",
    "agents/validator",
    "agents/pacing-agent",
    "agents/combat-agent",
    "agents/memory-ranker",
    "agents/recap-agent",
    "agents/scale-selector-agent",
    "agents/director",
    "agents/compactor",
    "agents/relationship-analyzer",
    "agents/production-agent",
    "agents/context-block-generator",
    "agents/meta-director",
  ];
  for (const id of agents) {
    it(`${id} includes structured_output_contract`, () => {
      const p = getPrompt(id);
      expect(p.includedFragments).toContain("fragments/structured_output_contract");
    });
  }
});

describe("prompt structure — Chronicler prompt references load-bearing tools", () => {
  // If Chronicler's prompt forgets to document a tool, Chronicler stops
  // calling it — which silently strips state persistence. Keep these
  // references pinned.
  const chronicler = getPrompt("agents/chronicler").content;
  const requiredTools = [
    "register_npc",
    "spawn_transient",
    "update_npc",
    "register_location",
    "register_faction",
    "write_semantic_memory",
    "write_episodic_summary",
    "record_relationship_event",
    "plant_foreshadowing_candidate",
    "update_context_block",
    "write_director_note",
    "update_voice_patterns",
    "update_arc_plan",
    "trigger_compactor",
    "adjust_spotlight_debt",
  ];
  for (const tool of requiredTools) {
    it(`references ${tool}`, () => {
      expect(chronicler).toContain(tool);
    });
  }
});

describe("prompt structure — WorldBuilder editor posture (Phase 6B)", () => {
  const wb = getPrompt("agents/world-builder").content;
  it("does NOT list REJECT as a valid decision value", () => {
    // v4 reshape dropped REJECT. If the prompt reintroduces it, narrative
    // trust regresses. Admonitions teaching "you don't have REJECT" are
    // OK; we grep for concrete valid-value spellings that would make
    // the model produce REJECT on output.
    expect(wb).not.toMatch(/"REJECT"/); // no JSON-quoted value
    expect(wb).not.toMatch(/\|\s*REJECT\b/); // no "| REJECT" in an enum union
  });
  it("lists ACCEPT | CLARIFY | FLAG as decision values", () => {
    expect(wb).toMatch(/"decision":\s*"ACCEPT"\s*\|\s*"CLARIFY"\s*\|\s*"FLAG"/);
  });
});
