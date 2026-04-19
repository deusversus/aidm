import { tiers } from "@/lib/env";
import { getGoogle } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { type AgentDeps, defaultLogger } from "./types";

/**
 * OverrideHandler — classifies `/meta` and `/override` commands.
 *
 * Two command families, very different binding semantics:
 *   - `/override` — hard constraint. Becomes part of KA's Block 4 as
 *     `## PLAYER OVERRIDES (MUST BE ENFORCED)`.
 *   - `/meta` — advisory calibration. Persisted as a
 *     session_zero_voice-category memory; KA weighs, doesn't obey.
 *
 * The handler parses one command at a time. The router extracts the
 * command prefix (`/override X` → passes "X" here with mode "override"),
 * and the handler fills in category, scope, conflicts, and an
 * acknowledgement the player sees.
 *
 * Tier: fast (Gemini 3.1 Flash). Simple classification + short ack.
 * Failure policy: parse fail → retry once → fallback that surfaces the raw
 * command as a NARRATIVE_DEMAND override (never silently drop).
 */

export const OverrideMode = z.enum(["override", "meta"]);
export const OverrideCategory = z.enum([
  "NPC_PROTECTION",
  "CONTENT_CONSTRAINT",
  "NARRATIVE_DEMAND",
  "TONE_REQUIREMENT",
]);
export const OverrideScope = z.enum(["campaign", "session", "arc"]);

export const OverrideHandlerInput = z.object({
  command: z
    .string()
    .min(1)
    .describe("Raw command text (may include leading /override or /meta prefix)"),
  prior_overrides: z
    .array(
      z.object({
        id: z.string(),
        category: OverrideCategory,
        value: z.string(),
        scope: OverrideScope,
      }),
    )
    .default([]),
});
// Use input-side type so callers can omit defaulted fields.
export type OverrideHandlerInput = z.input<typeof OverrideHandlerInput>;

export const OverrideHandlerOutput = z.object({
  mode: OverrideMode,
  category: OverrideCategory.nullable(),
  value: z.string().min(1),
  scope: OverrideScope.default("campaign"),
  conflicts_with: z.array(z.string()).default([]),
  ack_phrasing: z.string().min(1),
});
export type OverrideHandlerOutput = z.infer<typeof OverrideHandlerOutput>;

const MAX_ATTEMPTS = 2;

export interface OverrideHandlerDeps extends AgentDeps {
  google?: () => Pick<GoogleGenAI, "models">;
}

function renderPrompt(): string {
  return getPrompt("agents/override-handler").content;
}

function buildUserContent(input: z.output<typeof OverrideHandlerInput>): string {
  const priors = input.prior_overrides.length
    ? input.prior_overrides
        .map((o) => `  - [${o.id}] ${o.category} (${o.scope}): ${o.value}`)
        .join("\n")
    : "  (none)";
  return [
    `command: ${input.command}`,
    `prior_overrides:\n${priors}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

function buildFallback(input: z.output<typeof OverrideHandlerInput>): OverrideHandlerOutput {
  const isOverride = /^\s*\/override\b/i.test(input.command);
  const stripped = input.command.replace(/^\s*\/(?:override|meta)\s*/i, "").trim();
  return {
    mode: isOverride ? "override" : "meta",
    category: isOverride ? "NARRATIVE_DEMAND" : null,
    value: stripped || input.command,
    scope: "campaign",
    conflicts_with: [],
    ack_phrasing: isOverride
      ? "Noted. Recorded as-written."
      : "Heard. I'll weigh it as the story continues.",
  };
}

export async function handleOverride(
  input: OverrideHandlerInput,
  deps: OverrideHandlerDeps = {},
): Promise<OverrideHandlerOutput> {
  const parsed = OverrideHandlerInput.parse(input);
  const logger = deps.logger ?? defaultLogger;
  const google = deps.google ?? getGoogle;
  const model = tiers.fast.model;
  const span = deps.trace?.span({
    name: "agent:override-handler",
    input: parsed,
    metadata: { model, tier: "fast" },
  });

  const systemPrompt = renderPrompt();
  const userContent = buildUserContent(parsed);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reminder =
        attempt > 1
          ? "\n\nYour prior response was not valid JSON against the schema. Return ONLY the JSON object — no prose, no markdown fences. Every required field must be present."
          : "";
      const client = google();
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: `${userContent}${reminder}` }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      });

      const text = response.text?.trim();
      if (!text) throw new Error("empty response");
      const validated = OverrideHandlerOutput.parse(JSON.parse(extractJson(text)));
      span?.end({ output: validated, metadata: { attempt } });
      return validated;
    } catch (err) {
      lastError = err;
      logger("warn", "OverrideHandler attempt failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fallback = buildFallback(parsed);
  logger("error", "OverrideHandler fell back after retry", {
    error: lastError instanceof Error ? lastError.message : String(lastError),
    fallback_mode: fallback.mode,
  });
  span?.end({
    output: fallback,
    metadata: {
      fallback: true,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
  return fallback;
}
