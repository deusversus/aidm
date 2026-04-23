import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockQueryFn } from "@/lib/llm/mock/testing";
import { type CampaignProviderConfig, anthropicFallbackConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import { Profile } from "@/lib/types/profile";
import type { IntentOutput } from "@/lib/types/turn";
import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { type KeyAnimatorInput, runKeyAnimator } from "../key-animator";

/**
 * KA tests here focus on the per-campaign modelContext wiring (M1.5
 * Commit D). Streaming + cache-boundary behavior is exercised by
 * integration tests against the real Claude Agent SDK — those aren't
 * in the unit suite because they'd need a live Anthropic key.
 */

function loadBebop(): Profile {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  return Profile.parse(jsYaml.load(raw));
}

const intent: IntentOutput = {
  intent: "DEFAULT",
  action: "look around",
  target: "",
  epicness: 0.2,
  special_conditions: [],
  confidence: 0.9,
};

const toolContext = {
  campaignId: "c-1",
  userId: "u-1",
  db: {} as never,
} as unknown as AidmToolContext;

function baseInput(modelContext: CampaignProviderConfig): KeyAnimatorInput {
  return {
    profile: loadBebop(),
    campaign: {},
    workingMemory: [],
    compaction: [],
    block4: {
      player_message: "look around",
      intent,
      player_overrides: [],
    },
    modelContext,
    toolContext,
  };
}

describe("runKeyAnimator — provider guard (M1.5 Commit D)", () => {
  it("throws when modelContext.provider is 'google' (Google-KA lands M3.5)", async () => {
    const googleContext: CampaignProviderConfig = {
      provider: "google",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    const iter = runKeyAnimator(baseInput(googleContext));
    await expect(iter.next()).rejects.toThrow(/google/i);
  });

  it("throws when modelContext.provider is 'openai' (OpenAI-KA lands M5.5)", async () => {
    const openaiContext: CampaignProviderConfig = {
      provider: "openai",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gpt-5.4",
        thinking: "gpt-5.4",
        creative: "gpt-5.4",
      },
    };
    const iter = runKeyAnimator(baseInput(openaiContext));
    await expect(iter.next()).rejects.toThrow(/openai/i);
  });

  it("passes creative-tier model from modelContext into the Agent SDK query", async () => {
    let seenModel: string | undefined;
    const customAnthropicContext: CampaignProviderConfig = {
      provider: "anthropic",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101",
        creative: "claude-sonnet-4-6", // cost-down creative; snapshot
      },
    };
    // Unified queryFn stub with onCall capture — replaces the inline
    // async-generator pattern. Phase F follow-up to Phase E migration.
    const queryFn = createMockQueryFn([
      {
        onCall: (args) => {
          seenModel = (args.options as { model?: string }).model;
        },
      },
    ]);
    const events: string[] = [];
    for await (const ev of runKeyAnimator(baseInput(customAnthropicContext), { queryFn })) {
      events.push(ev.kind);
    }
    expect(seenModel).toBe("claude-sonnet-4-6");
    expect(events).toContain("final");
  });

  it("passes consultant models from modelContext.tier_models (thinking + fast)", async () => {
    let seenAgents: Record<string, { model?: string }> | undefined;
    const queryFn = createMockQueryFn([
      {
        onCall: (args) => {
          seenAgents = (args.options as { agents?: Record<string, { model?: string }> }).agents;
        },
      },
    ]);
    for await (const _ of runKeyAnimator(baseInput(anthropicFallbackConfig()), { queryFn })) {
      // drain
    }
    // thinking default changed 2026-04-23 from Opus 4.7 → Sonnet 4.6 (cost).
    expect(seenAgents?.["outcome-judge"]?.model).toBe("claude-sonnet-4-6");
    expect(seenAgents?.validator?.model).toBe("claude-sonnet-4-6");
    expect(seenAgents?.["memory-ranker"]?.model).toBe("claude-haiku-4-5-20251001"); // fast default
    expect(seenAgents?.recap?.model).toBe("claude-haiku-4-5-20251001");
  });
});
