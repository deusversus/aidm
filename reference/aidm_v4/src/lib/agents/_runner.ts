import { getAnthropic, getGoogle } from "@/lib/llm";
import { type UsageStats, estimateCostUsd } from "@/lib/llm/pricing";
import { getPrompt } from "@/lib/prompts";
import { anthropicFallbackConfig } from "@/lib/providers";
import type { TierName } from "@/lib/providers";
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
 * **Per-campaign provider dispatch (M1.5).** The runner reads
 * `deps.modelContext` — the campaign's `{ provider, tier_models }` — to
 * decide which provider SDK to hit and which model to ask for. When
 * modelContext is absent (scripts, `/api/ready`, tests that don't care
 * about provider), it falls back to `anthropicFallbackConfig()`. Never
 * reads `env.ts` tiers globally in the hot path.
 *
 * Provider support status at M1.5:
 *   - "anthropic" → live
 *   - "google"    → throws until M3.5 Google-KA lands
 *   - "openai"    → throws until M5.5
 *   - "openrouter"→ throws until M5.5
 *
 * KA does NOT use this runner — it runs on Claude Agent SDK with its
 * own streaming + tool loop. This runner is for structured-output
 * consultants only.
 */

export interface AgentRunnerConfig<TOutput> {
  /** Agent name for span + log identification (e.g. `outcome-judge`). */
  agentName: string;
  /** Which tier's model to pull from `modelContext.tier_models`. */
  tier: TierName;
  /** Fully-rendered system prompt (caller resolves via prompt registry). */
  systemPrompt: string;
  /**
   * Optional prompt-registry id that produced `systemPrompt`. When
   * present, the runner records the prompt's SHA-256 fingerprint via
   * `deps.recordPrompt(agentName, fingerprint)` so the turn workflow
   * can persist it to `turns.prompt_fingerprints`. Absent for tests
   * that pass a literal systemPrompt string — they skip recording.
   */
  promptId?: string;
  /** Fully-rendered user message for this invocation. */
  userContent: string;
  /** Zod schema the parsed response must satisfy. */
  outputSchema: z.ZodType<TOutput>;
  /** Sentinel returned when retries exhaust. */
  fallback: TOutput;
  /** Max output tokens. Defaults are reasonable for structured JSON. */
  maxTokens?: number;
  /**
   * Extended-thinking budget for Anthropic thinking-capable models.
   * Silently ignored when the selected model doesn't support it or
   * the provider path doesn't model thinking this way.
   */
  thinkingBudget?: number;
  /** Sampling temperature for first attempt. Retry forces temp 0. */
  temperature?: number;
  /**
   * Optional input payload attached to the Langfuse span on open.
   * Helps debugging — Langfuse renders it as the span body. Keep
   * small (a few KB at most); large payloads inflate trace storage.
   */
  spanInput?: unknown;
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

interface ProviderCallResult {
  raw: string;
  usage: UsageStats;
}

async function callAnthropic(
  config: AgentRunnerConfig<unknown>,
  userMessage: string,
  model: string,
  anthropic: () => Pick<Anthropic, "messages">,
): Promise<ProviderCallResult> {
  const client = anthropic();
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
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
  // Anthropic usage fields — input/output always present; cache-read +
  // cache-creation present when the prompt uses cache_control breakpoints.
  const usage: UsageStats = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage?.cache_creation_input_tokens ?? 0,
  };
  return { raw, usage };
}

async function callGoogle(
  config: AgentRunnerConfig<unknown>,
  userMessage: string,
  model: string,
  temperature: number,
  google: () => Pick<GoogleGenAI, "models">,
): Promise<ProviderCallResult> {
  const client = google();
  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: config.systemPrompt,
      responseMimeType: "application/json",
      temperature,
    },
  });
  const text = response.text?.trim();
  if (!text) throw new Error("empty response");
  // Google's usageMetadata: promptTokenCount / candidatesTokenCount. No
  // cache-read split at the structured-output tier (context caching is
  // a separate API surface). Map to the canonical UsageStats shape.
  const usage: UsageStats = {
    input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  return { raw: text, usage };
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
  const ctx = deps.modelContext ?? anthropicFallbackConfig();
  const model = ctx.tier_models[config.tier];

  // Record the prompt fingerprint for this turn's audit trail. Done
  // once, before any retries, so the fingerprint reflects the prompt
  // the agent intended to run — not whatever got mangled mid-retry.
  if (config.promptId && deps.recordPrompt) {
    try {
      const { fingerprint } = getPrompt(config.promptId);
      deps.recordPrompt(config.agentName, fingerprint);
    } catch {
      // Prompt-id lookup failure is non-fatal here — the LLM call
      // uses config.systemPrompt directly. Log path will catch it
      // via the normal agent-failure surface if systemPrompt is
      // actually wrong.
    }
  }

  const span = deps.trace?.span({
    name: `agent:${config.agentName}`,
    input: config.spanInput,
    metadata: {
      tier: config.tier,
      provider: ctx.provider,
      model,
    },
  });

  // Provider dispatch — resolve the caller function once, outside the
  // retry loop. Providers that don't yet have a KA substrate throw
  // immediately (helpful error, no silent fallback to anthropic —
  // that would mask misconfiguration).
  let invoke: (userMessage: string, temperature: number) => Promise<ProviderCallResult>;
  switch (ctx.provider) {
    case "anthropic": {
      const anthropic = deps.anthropic ?? getAnthropic;
      invoke = (msg) => callAnthropic(config, msg, model, anthropic);
      break;
    }
    case "google": {
      const google = deps.google ?? getGoogle;
      invoke = (msg, temp) => callGoogle(config, msg, model, temp, google);
      break;
    }
    case "openai":
    case "openrouter":
      throw new Error(
        `Provider "${ctx.provider}" is not yet available — OpenAI-KA + OpenRouter shim land at M5.5. See src/lib/providers/${ctx.provider}.ts.`,
      );
  }

  // Cost accumulates ACROSS retries — every attempt that made a real
  // LLM call cost money, including the one that returned unparsable
  // JSON. This is honest accounting: if a retry saved the run, the
  // user still paid for both attempts.
  let accumulatedCostUsd = 0;

  const attemptStart = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reminder = attempt > 1 ? RETRY_REMINDER : "";
      const message = `${config.userContent}${reminder}`;
      const temperature = attempt === 1 ? (config.temperature ?? 0.2) : 0;

      const { raw, usage } = await invoke(message, temperature);
      accumulatedCostUsd += estimateCostUsd(model, usage);

      const parsed = config.outputSchema.parse(JSON.parse(extractJson(raw)));
      span?.end({ output: parsed, metadata: { attempt, costUsd: accumulatedCostUsd } });
      deps.recordCost?.(config.agentName, accumulatedCostUsd);
      // Only emit a per-agent ok log when a retry saved the call —
      // the success-at-attempt-1 case would be too noisy (fires on
      // every consultant on every turn). Retries are rare enough to
      // be signal.
      if (attempt > 1) {
        logger("info", `${config.agentName}: ok after retry`, {
          ...deps.logContext,
          agent: config.agentName,
          tier: config.tier,
          provider: ctx.provider,
          model,
          attempt,
          costUsd: accumulatedCostUsd,
          durationMs: Date.now() - attemptStart,
        });
      }
      return parsed;
    } catch (err) {
      lastError = err;
      logger("warn", `${config.agentName}: attempt failed`, {
        ...deps.logContext,
        agent: config.agentName,
        tier: config.tier,
        provider: ctx.provider,
        model,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger("error", `${config.agentName}: fell back after retry`, {
    ...deps.logContext,
    agent: config.agentName,
    tier: config.tier,
    provider: ctx.provider,
    model,
    costUsd: accumulatedCostUsd,
    durationMs: Date.now() - attemptStart,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  span?.end({
    output: config.fallback,
    metadata: {
      fallback: true,
      costUsd: accumulatedCostUsd,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
  // Fallback path still incurred cost — record whatever we accumulated.
  deps.recordCost?.(config.agentName, accumulatedCostUsd);
  return config.fallback;
}
