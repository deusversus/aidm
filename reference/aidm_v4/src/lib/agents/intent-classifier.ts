import { getPrompt } from "@/lib/prompts";
import { IntentOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";
import { defaultLogger } from "./types";

/**
 * IntentClassifier — fast-tier pre-pass that annotates the player message.
 *
 * Reads the player's message + last few turns of context, returns the shape
 * the rest of the turn needs (intent type, action, target, epicness,
 * special conditions, confidence). Not a decider, not a narrator — an
 * annotator. KA orchestrates the turn; this agent tells KA what shape
 * it's working with before it starts.
 *
 * **Provider dispatch (M1.5).** Uses the shared `runStructuredAgent`,
 * so it runs on whatever provider the caller's `modelContext` points
 * at. Campaign on Anthropic → Haiku (via `@anthropic-ai/sdk`).
 * Campaign on Google (M3.5+) → Gemini Flash-Lite (via `@google/genai`).
 * Both produce structured JSON; the prompt's structured-output
 * fragment carries the provider-agnostic instructions.
 *
 * Failure policy (§5.4):
 *   - JSON/schema parse failure → retry once with stricter reminder,
 *     then fallback to DEFAULT with confidence 0.0 (inside runner).
 *   - Low confidence (< 0.6) is surfaced as a warn log but returned
 *     as-is. Callers decide how to weight it.
 */

export const IntentClassifierInput = z.object({
  playerMessage: z.string().min(1),
  recentTurnsSummary: z.string().default(""),
  campaignPhase: z.enum(["sz", "playing", "arc_transition"]).default("playing"),
});
// Use input-side type so callers can omit defaulted fields.
export type IntentClassifierInput = z.input<typeof IntentClassifierInput>;

const DEFAULT_FALLBACK: IntentOutput = {
  intent: "DEFAULT",
  action: undefined,
  target: undefined,
  epicness: 0.2,
  special_conditions: [],
  confidence: 0,
};

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export type IntentClassifierDeps = AgentRunnerDeps;

function buildUserContent(input: z.output<typeof IntentClassifierInput>): string {
  return [
    `playerMessage: ${input.playerMessage}`,
    `recentTurnsSummary: ${input.recentTurnsSummary || "(none)"}`,
    `campaignPhase: ${input.campaignPhase}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function classifyIntent(
  input: IntentClassifierInput,
  deps: IntentClassifierDeps = {},
): Promise<IntentOutput> {
  const parsedInput = IntentClassifierInput.parse(input);
  const logger = deps.logger ?? defaultLogger;

  const result = await runStructuredAgent(
    {
      agentName: "intent-classifier",
      tier: "fast",
      systemPrompt: getPrompt("agents/intent-classifier").content,
      promptId: "agents/intent-classifier",
      userContent: buildUserContent(parsedInput),
      outputSchema: IntentOutput,
      fallback: DEFAULT_FALLBACK,
      maxTokens: 1024,
      spanInput: parsedInput,
    },
    deps,
  );

  if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
    logger("warn", "IntentClassifier low confidence", {
      confidence: result.confidence,
      intent: result.intent,
      message_excerpt: parsedInput.playerMessage.slice(0, 80),
    });
  }

  return result;
}
