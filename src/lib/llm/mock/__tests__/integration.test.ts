import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKeyAnimator } from "@/lib/agents/key-animator";
import { anthropicFallbackConfig } from "@/lib/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMockRuntimeForTesting } from "../runtime";

/**
 * End-to-end integration: `AIDM_MOCK_LLM=1` + a fixture on disk + a
 * real `runKeyAnimator` call — verifies the env-gated queryFn path
 * hands the SDK mock to KA, which streams the fixture's text through.
 *
 * This closes the thin-coverage gap the meta-audit flagged: prior
 * Phase D tests exercised `createMockQuery` + `getQueryFn` in
 * isolation; this test walks the full AIDM_MOCK_LLM=1 →
 * getQueryFn → runKeyAnimator → text deltas chain.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mockllm-integration-"));
  resetMockRuntimeForTesting();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "AIDM_MOCK_LLM");
  Reflect.deleteProperty(process.env, "MOCKLLM_FIXTURES_DIR");
  resetMockRuntimeForTesting();
});

const MIN_PROFILE = {
  id: "integration-test",
  title: "Integration",
  alternate_titles: [],
  media_type: "anime" as const,
  status: "completed" as const,
  relation_type: "canonical" as const,
  ip_mechanics: {
    power_distribution: {
      peak_tier: "T7" as const,
      typical_tier: "T9" as const,
      floor_tier: "T10" as const,
      gradient: "flat" as const,
    },
    stat_mapping: {
      has_canonical_stats: false,
      confidence: 50,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    },
    combat_style: "tactical" as const,
    storytelling_tropes: {
      tournament_arc: false,
      training_montage: false,
      power_of_friendship: false,
      mentor_death: false,
      chosen_one: false,
      tragic_backstory: false,
      redemption_arc: false,
      betrayal: false,
      sacrifice: false,
      transformation: false,
      forbidden_technique: false,
      time_loop: false,
      false_identity: false,
      ensemble_focus: false,
      slow_burn_romance: false,
    },
    world_setting: { genre: [], locations: [], factions: [] },
    voice_cards: [],
    author_voice: {
      sentence_patterns: [],
      structural_motifs: [],
      dialogue_quirks: [],
      emotional_rhythm: [],
      example_voice: "",
    },
    visual_style: { art_style: "", color_palette: "", reference_descriptors: [] },
  },
  canonical_dna: {
    pacing: 5,
    continuity: 5,
    density: 5,
    temporal_structure: 5,
    optimism: 5,
    darkness: 5,
    comedy: 5,
    emotional_register: 5,
    intimacy: 5,
    fidelity: 5,
    reflexivity: 5,
    avant_garde: 5,
    epistemics: 5,
    moral_complexity: 5,
    didacticism: 5,
    cruelty: 5,
    power_treatment: 5,
    scope: 5,
    agency: 5,
    interiority: 5,
    conflict_style: 5,
    register: 5,
    empathy: 5,
    accessibility: 5,
  },
  canonical_composition: {
    tension_source: "existential" as const,
    power_expression: "balanced" as const,
    narrative_focus: "internal" as const,
    mode: "standard" as const,
    antagonist_origin: "internal" as const,
    antagonist_multiplicity: "absent" as const,
    arc_shape: "rising" as const,
    resolution_trajectory: "ambiguous" as const,
    escalation_pattern: "linear" as const,
    status_quo_stability: "gradual" as const,
    player_role: "protagonist" as const,
    choice_weight: "local" as const,
    story_time_density: "incident" as const,
  },
  director_personality: "stub",
};

describe("AIDM_MOCK_LLM end-to-end via runKeyAnimator", () => {
  it("streams fixture text through KA when env gate is active", async () => {
    // Write a fixture the mock will match against KA's system prompt.
    writeFileSync(
      join(tmp, "ka-integration.yaml"),
      `
id: integration-ka-text
provider: anthropic
match:
  system_includes: ["You are KeyAnimator"]
response:
  id: msg_integration
  type: message
  role: assistant
  content:
    - type: text
      text: "The mock served this narrative end-to-end."
  model: claude-opus-4-7
  stop_reason: end_turn
  stop_sequence: null
  usage:
    input_tokens: 500
    output_tokens: 20
`,
    );
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_FIXTURES_DIR = tmp;

    // Call runKeyAnimator with NO deps.queryFn — it should pick up
    // the mock via getQueryFn() automatically.
    const toolContext = {
      campaignId: "c-int",
      userId: "u-int",
      db: {} as never,
    };
    const events = [];
    for await (const ev of runKeyAnimator({
      profile: MIN_PROFILE,
      campaign: { active_dna: undefined, active_composition: undefined },
      workingMemory: [],
      compaction: [],
      block4: {
        player_message: "Test input",
        intent: {
          intent: "DEFAULT",
          epicness: 0.2,
          special_conditions: [],
          confidence: 0.9,
        },
        player_overrides: [],
      },
      modelContext: anthropicFallbackConfig(),
      toolContext,
    })) {
      events.push(ev);
    }

    const textEvents = events.filter((e) => e.kind === "text") as Array<{
      kind: "text";
      delta: string;
    }>;
    const fullNarrative = textEvents.map((e) => e.delta).join("");
    expect(fullNarrative).toContain("mock served this narrative end-to-end");

    const final = events[events.length - 1] as {
      kind: "final";
      narrative: string;
      costUsd: number | null;
    };
    expect(final.kind).toBe("final");
    expect(final.narrative).toContain("mock served");
    expect(final.costUsd).toBeGreaterThan(0);
  });
});
