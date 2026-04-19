import { tiers } from "@/lib/env";
import { getGoogle } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import { IntentOutput } from "@/lib/types/turn";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { type AgentDeps, defaultLogger } from "./types";

/**
 * IntentClassifier — fast-tier annotation pass.
 *
 * Reads the player's message + last few turns of context, returns the shape
 * the rest of the turn needs (intent type, action, target, epicness,
 * special conditions, confidence). Not a decider, not a narrator — an
 * annotator. KA orchestrates the turn; this agent tells KA what shape it's
 * working with before it starts.
 *
 * Tier: fast (Gemini 3.1 Flash via `@google/genai`).
 * Latency target: p50 400ms, p95 800ms.
 * Failure policy (§5.4):
 *   - JSON/schema parse failure → retry once with a stricter reminder,
 *     then fallback to DEFAULT with confidence 0.0
 *   - 5xx / network error → one retry with exponential backoff, then
 *     fallback to DEFAULT with confidence 0.0
 *   - `confidence < 0.6` → logged warning; returned as-is. M2+ may
 *     route to an IntentResolver; at M1 we surface the uncertainty to
 *     KA via confidence and let it decide.
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

const MAX_ATTEMPTS = 2;

export interface IntentClassifierDeps extends AgentDeps {
  /** Inject a mock Google client in tests. Defaults to the singleton. */
  google?: () => Pick<GoogleGenAI, "models">;
}

function renderPrompt(): string {
  return getPrompt("agents/intent-classifier").content;
}

function buildUserContent(input: IntentClassifierInput): string {
  return [
    `playerMessage: ${input.playerMessage}`,
    `recentTurnsSummary: ${input.recentTurnsSummary || "(none)"}`,
    `campaignPhase: ${input.campaignPhase}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function extractJson(text: string): string {
  // Some models emit markdown fences despite instructions. Strip them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

export async function classifyIntent(
  input: IntentClassifierInput,
  deps: IntentClassifierDeps = {},
): Promise<IntentOutput> {
  const parsedInput = IntentClassifierInput.parse(input);
  const logger = deps.logger ?? defaultLogger;
  const google = deps.google ?? getGoogle;
  const model = tiers.fast.model;
  const span = deps.trace?.span({
    name: "agent:intent-classifier",
    input: parsedInput,
    metadata: { model, tier: "fast" },
  });

  const systemPrompt = renderPrompt();
  const userContent = buildUserContent(parsedInput);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reminder =
        attempt > 1
          ? "\n\nYour prior response was not valid JSON against the schema. Return ONLY the JSON object, no prose, no markdown fences. Every required field must be present."
          : "";
      const client = google();
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: `${userContent}${reminder}` }],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          temperature: attempt === 1 ? 0.2 : 0.0,
        },
      });

      const text = response.text?.trim();
      if (!text) throw new Error("empty response");

      const parsed = IntentOutput.parse(JSON.parse(extractJson(text)));

      if (parsed.confidence < LOW_CONFIDENCE_THRESHOLD) {
        logger("warn", "IntentClassifier low confidence", {
          confidence: parsed.confidence,
          intent: parsed.intent,
          message_excerpt: parsedInput.playerMessage.slice(0, 80),
        });
      }

      span?.end({ output: parsed, metadata: { attempt } });
      return parsed;
    } catch (err) {
      lastError = err;
      logger("warn", "IntentClassifier attempt failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger("error", "IntentClassifier fell back to DEFAULT after retry", {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  span?.end({
    output: DEFAULT_FALLBACK,
    metadata: {
      fallback: true,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
  // Return the fallback rather than throw — the turn pipeline must continue.
  // Callers that need to know about the failure inspect the trace or wire a
  // logger that surfaces the warn/error lines above.
  return DEFAULT_FALLBACK;
}
