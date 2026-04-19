import { tiers } from "@/lib/env";
import { getAnthropic, getGoogle } from "@/lib/llm";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { type AgentDeps, type AgentLogger, defaultLogger } from "./types";

/**
 * Shared runner for structured-output agent calls.
 *
 * Every agent in the judgment cascade has the same shape: render a
 * system prompt, ask the model for JSON matching a Zod schema, parse
 * the response, retry once on failure, fall back to a well-typed
 * sentinel if retries exhaust. This module is the single implementation
 * of that shape. Each agent becomes: schemas + user-content builder +
 * fallback + one call to `runStructuredAgent`.
 *
 * Tier dispatch:
 *   - "fast"     → Gemini 3.1 Flash via @google/genai
 *   - "thinking" → Opus 4.7 via @anthropic-ai/sdk, optional extended
 *                  thinking budget
 *   - "probe"    → Haiku (reachability only; not used for agents)
 *
 * The runner does NOT know about tools, streaming, or MCP. Agents that
 * need those capabilities (KA) bypass this runner and use Claude Agent
 * SDK directly.
 */

export type AgentTier = "fast" | "thinking";

export interface AgentRunnerConfig<TOutput> {
  /** Agent name for span + log identification (e.g. `outcome-judge`). */
  agentName: string;
  /** Model tier — selects provider + model. */
  tier: AgentTier;
  /** Fully-rendered system prompt (caller resolves via prompt registry). */
  systemPrompt: string;
  /** Fully-rendered user message for this invocation. */
  userContent: string;
  /** Zod schema the parsed response must satisfy. */
  outputSchema: z.ZodType<TOutput>;
  /** Sentinel returned when retries exhaust. */
  fallback: TOutput;
  /** Max output tokens. Defaults are reasonable for structured JSON. */
  maxTokens?: number;
  /** Extended-thinking budget for Opus. Ignored on fast tier. */
  thinkingBudget?: number;
  /** Sampling temperature for first attempt. Retry forces temp 0. */
  temperature?: number;
}

export interface AgentRunnerDeps extends AgentDeps {
  /** Inject a mock Gemini client in tests. */
  google?: () => Pick<GoogleGenAI, "models">;
  /** Inject a mock Anthropic client in tests. */
  anthropic?: () => Pick<Anthropic, "messages">;
}

const MAX_ATTEMPTS = 2;
const RETRY_REMINDER =
  "\n\nYour prior response was not valid JSON against the schema. Return ONLY the JSON object — no prose, no markdown fences. Every required field must be present.";

/** Strips ```json ... ``` fences the model sometimes emits despite instructions. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

async function callFast(
  config: AgentRunnerConfig<unknown>,
  userMessage: string,
  temperature: number,
  google: () => Pick<GoogleGenAI, "models">,
): Promise<string> {
  const client = google();
  const response = await client.models.generateContent({
    model: tiers.fast.model,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: config.systemPrompt,
      responseMimeType: "application/json",
      temperature,
    },
  });
  const text = response.text?.trim();
  if (!text) throw new Error("empty response");
  return text;
}

async function callThinking(
  config: AgentRunnerConfig<unknown>,
  userMessage: string,
  anthropic: () => Pick<Anthropic, "messages">,
): Promise<string> {
  const client = anthropic();
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: tiers.thinking.model,
    max_tokens: config.maxTokens ?? 1024,
    system: config.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (config.thinkingBudget && config.thinkingBudget > 0) {
    params.thinking = { type: "enabled", budget_tokens: config.thinkingBudget };
    // Extended thinking requires max_tokens > budget_tokens. Guard.
    if ((params.max_tokens ?? 0) <= config.thinkingBudget) {
      params.max_tokens = config.thinkingBudget + 1024;
    }
  }
  const response = await client.messages.create(params);
  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlocks.map((b) => b.text).join("");
  if (!raw.trim()) throw new Error("empty response");
  return raw;
}

/**
 * Run a structured-output agent call with retry + fallback.
 * Returns the validated output, or the configured fallback if retries
 * exhaust. Never throws for LLM/parse failures — the turn pipeline must
 * continue. Input validation errors (caller passed malformed args) are
 * raised at the agent's public entry point, not here.
 */
export async function runStructuredAgent<TOutput>(
  config: AgentRunnerConfig<TOutput>,
  deps: AgentRunnerDeps = {},
): Promise<TOutput> {
  const logger: AgentLogger = deps.logger ?? defaultLogger;
  const google = deps.google ?? getGoogle;
  const anthropic = deps.anthropic ?? getAnthropic;
  const span = deps.trace?.span({
    name: `agent:${config.agentName}`,
    metadata: {
      tier: config.tier,
      model: config.tier === "fast" ? tiers.fast.model : tiers.thinking.model,
    },
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reminder = attempt > 1 ? RETRY_REMINDER : "";
      const message = `${config.userContent}${reminder}`;
      const temperature = attempt === 1 ? (config.temperature ?? 0.2) : 0;

      const raw =
        config.tier === "fast"
          ? await callFast(config, message, temperature, google)
          : await callThinking(config, message, anthropic);

      const parsed = config.outputSchema.parse(JSON.parse(extractJson(raw)));
      span?.end({ output: parsed, metadata: { attempt } });
      return parsed;
    } catch (err) {
      lastError = err;
      logger("warn", `${config.agentName} attempt failed`, {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger("error", `${config.agentName} fell back after retry`, {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  span?.end({
    output: config.fallback,
    metadata: {
      fallback: true,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
  return config.fallback;
}
