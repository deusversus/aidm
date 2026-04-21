import { type CampaignProviderConfig, anthropicFallbackConfig } from "@/lib/providers";
import type { AidmToolContext } from "@/lib/tools";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { describe, expect, it } from "vitest";
import { type ChroniclerInput, runChronicler } from "../chronicler";

/**
 * Chronicler unit tests. The real tool calls + subagent invocations
 * require a live Agent SDK subprocess; integration tests land in 7.4
 * when Chronicler is wired into the turn workflow via `after()`. Here
 * we cover:
 *   - Provider guard (anthropic-only at M1)
 *   - modelContext plumbing: fast tier → chronicler's model;
 *     thinking tier → relationship-analyzer consultant's model
 *   - User-message rendering includes intent + outcome + arc_trigger
 *   - recordPrompt receives both the chronicler + consultant fingerprints
 *   - toolCallCount accumulates from tool_use content blocks
 */

const intent: IntentOutput = {
  intent: "SOCIAL",
  action: "ask about the past",
  target: "Jet",
  epicness: 0.3,
  special_conditions: [],
  confidence: 0.88,
};

const outcome: OutcomeOutput = {
  success_level: "success",
  difficulty_class: 12,
  modifiers: [],
  narrative_weight: "SIGNIFICANT",
  consequence: "Jet opens up about his time in the ISSP.",
  rationale: "Social success, moderate DC, meaningful relational beat.",
};

const toolContext = {
  campaignId: "c-1",
  userId: "u-1",
  db: {} as never,
} as unknown as AidmToolContext;

function baseInput(modelContext: CampaignProviderConfig): ChroniclerInput {
  return {
    turnNumber: 8,
    playerMessage: "Jet, what did you really do in the ISSP?",
    narrative: "Jet set down the cup. His jaw tightened for a second before he spoke.",
    intent,
    outcome,
    arcTrigger: null,
    modelContext,
    toolContext,
  };
}

describe("runChronicler — provider guard + modelContext wiring (Commit 7.3)", () => {
  it("throws when provider is 'google' (Google-Chronicler lands M3.5)", async () => {
    const google: CampaignProviderConfig = {
      provider: "google",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gemini-3.1-flash-lite-preview",
        thinking: "gemini-3.1-pro-preview",
        creative: "gemini-3.1-pro-preview",
      },
    };
    await expect(runChronicler(baseInput(google))).rejects.toThrow(/google/i);
  });

  it("throws when provider is 'openai' (OpenAI-Chronicler lands M5.5)", async () => {
    const openai: CampaignProviderConfig = {
      provider: "openai",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "gpt-5.4",
        thinking: "gpt-5.4",
        creative: "gpt-5.4",
      },
    };
    await expect(runChronicler(baseInput(openai))).rejects.toThrow(/openai/i);
  });

  it("passes fast-tier model to Agent SDK options.model", async () => {
    let seenModel: string | undefined;
    const customAnthropic: CampaignProviderConfig = {
      provider: "anthropic",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-7",
        creative: "claude-opus-4-7",
      },
    };
    const queryFn = ((args: { options: { model?: string } }) => {
      seenModel = args.options.model;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })();
    }) as never;
    const result = await runChronicler(baseInput(customAnthropic), { queryFn });
    expect(seenModel).toBe("claude-haiku-4-5-20251001");
    expect(result.stopReason).toBe("end_turn");
  });

  it("passes thinking-tier model to the relationship-analyzer consultant", async () => {
    let seenAgents: Record<string, { model?: string }> | undefined;
    const queryFn = ((args: {
      options: { agents?: Record<string, { model?: string }> };
    }) => {
      seenAgents = args.options.agents;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })();
    }) as never;
    await runChronicler(baseInput(anthropicFallbackConfig()), { queryFn });
    expect(seenAgents?.["relationship-analyzer"]?.model).toBe("claude-opus-4-7");
  });

  it("renders the user message with intent + outcome + arc_trigger state", async () => {
    let seenPrompt: string | undefined;
    const queryFn = ((args: { prompt: string }) => {
      seenPrompt = args.prompt;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })();
    }) as never;
    await runChronicler(
      { ...baseInput(anthropicFallbackConfig()), arcTrigger: "session_boundary" },
      { queryFn },
    );
    expect(seenPrompt).toContain("turn_number: 8");
    expect(seenPrompt).toContain("intent: SOCIAL");
    expect(seenPrompt).toContain("outcome: SIGNIFICANT success");
    expect(seenPrompt).toContain("arc_trigger: session_boundary");
    expect(seenPrompt).toContain("ARE enabled");
  });

  it("user message surfaces arc_trigger:null as DISABLED signal", async () => {
    let seenPrompt: string | undefined;
    const queryFn = ((args: { prompt: string }) => {
      seenPrompt = args.prompt;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })();
    }) as never;
    await runChronicler(baseInput(anthropicFallbackConfig()), { queryFn });
    expect(seenPrompt).toContain("arc_trigger: null");
    expect(seenPrompt).toContain("DISABLED");
  });

  it("renders outcome:(none) when outcome is null (router short-circuit)", async () => {
    let seenPrompt: string | undefined;
    const queryFn = ((args: { prompt: string }) => {
      seenPrompt = args.prompt;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })();
    }) as never;
    await runChronicler({ ...baseInput(anthropicFallbackConfig()), outcome: null }, { queryFn });
    expect(seenPrompt).toContain("outcome: (none");
  });

  it("records chronicler + consultant fingerprints when recordPrompt is provided", async () => {
    const recorded: Record<string, string> = {};
    const queryFn = (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })()) as never;
    await runChronicler(baseInput(anthropicFallbackConfig()), {
      queryFn,
      recordPrompt: (name, fp) => {
        recorded[name] = fp;
      },
    });
    expect(Object.keys(recorded).sort()).toEqual([
      "chronicler",
      "chronicler:consultant:relationship-analyzer",
    ]);
    // Fingerprints are SHA-256 hex, 64 chars.
    for (const fp of Object.values(recorded)) {
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("counts tool_use blocks from assistant messages", async () => {
    const queryFn = (() =>
      (async function* () {
        // Simulate an assistant turn with 3 tool_use calls then a result.
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "write_episodic_summary" },
              { type: "tool_use", name: "register_npc" },
              { type: "text", text: "registering..." },
              { type: "tool_use", name: "adjust_spotlight_debt" },
            ],
          },
        };
        // A second assistant turn with 1 more tool_use.
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "write_semantic_memory" }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          session_id: "test",
        };
      })()) as never;
    const result = await runChronicler(baseInput(anthropicFallbackConfig()), { queryFn });
    expect(result.toolCallCount).toBe(4);
  });

  it("surfaces result.subtype !== 'success' as a thrown error", async () => {
    const queryFn = (() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          stop_reason: "max_turns",
          session_id: "test",
        };
      })()) as never;
    await expect(runChronicler(baseInput(anthropicFallbackConfig()), { queryFn })).rejects.toThrow(
      /error_max_turns/,
    );
  });
});
