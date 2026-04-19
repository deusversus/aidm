import { tiers } from "@/lib/env";
import { getAnthropic } from "@/lib/llm";
import { getPrompt } from "@/lib/prompts";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { type AgentDeps, defaultLogger } from "./types";

/**
 * WorldBuilder — thinking-tier validator for player in-fiction assertions.
 *
 * Fires when IntentClassifier returns WORLD_BUILDING. The player is claiming
 * a world-fact ("I reach into my satchel and pull out the amulet my
 * grandmother gave me", "I realize the guard is actually my cousin from
 * the village"). WorldBuilder decides whether the assertion becomes canon.
 *
 * Non-negotiable UX: rejection is **in-character DM dialogue**, never a
 * modal or error. The caller (the router) renders `response` verbatim to
 * the player on reject/clarify paths.
 *
 * Tier: thinking (Opus 4.7 with extended thinking).
 * Failure policy:
 *   - JSON/schema parse failure → retry once with stricter reminder,
 *     then fallback to a generic CLARIFY that asks the player to rephrase
 *     in-character (never blocks; never surfaces the failure)
 *   - 5xx → one retry, then the same CLARIFY fallback
 */

export const Canonicality = z.enum(["full_cast", "replaced_protagonist", "npcs_only", "inspired"]);
export type Canonicality = z.infer<typeof Canonicality>;

export const WorldBuilderInput = z.object({
  assertion: z.string().min(1),
  canonicalityMode: Canonicality,
  characterSummary: z.string().default(""),
  activeCanonRules: z.array(z.string()).default([]),
  recentTurnsSummary: z.string().default(""),
});
// Use the input-side type so callers can omit defaulted fields.
export type WorldBuilderInput = z.input<typeof WorldBuilderInput>;

export const WorldBuilderDecision = z.enum(["ACCEPT", "CLARIFY", "REJECT"]);

export const EntityUpdate = z.object({
  kind: z.enum(["npc", "item", "location", "fact"]),
  name: z.string(),
  details: z.string(),
});

export const WorldBuilderOutput = z.object({
  decision: WorldBuilderDecision,
  response: z.string().min(1),
  entityUpdates: z.array(EntityUpdate).default([]),
  rationale: z.string(),
});
export type WorldBuilderOutput = z.infer<typeof WorldBuilderOutput>;

const MAX_ATTEMPTS = 2;

const CLARIFY_FALLBACK: WorldBuilderOutput = {
  decision: "CLARIFY",
  response:
    "Something about the way you've told it isn't quite settling into the scene yet. Tell me more — when, where, how?",
  entityUpdates: [],
  rationale: "WorldBuilder fallback: retry budget exhausted; asking the player to rephrase.",
};

export interface WorldBuilderDeps extends AgentDeps {
  anthropic?: () => Pick<Anthropic, "messages">;
}

function renderPrompt(): string {
  return getPrompt("agents/world-builder").content;
}

function buildUserContent(input: z.output<typeof WorldBuilderInput>): string {
  return [
    `assertion: ${input.assertion}`,
    `canonicalityMode: ${input.canonicalityMode}`,
    `characterSummary: ${input.characterSummary || "(none)"}`,
    `activeCanonRules:\n${input.activeCanonRules.map((r) => `  - ${r}`).join("\n") || "  (none)"}`,
    `recentTurnsSummary: ${input.recentTurnsSummary || "(none)"}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

function extractJson(text: string): string {
  // Strip markdown fences the model sometimes emits despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

export async function validateAssertion(
  input: WorldBuilderInput,
  deps: WorldBuilderDeps = {},
): Promise<WorldBuilderOutput> {
  const parsed = WorldBuilderInput.parse(input);
  const logger = deps.logger ?? defaultLogger;
  const anthropic = deps.anthropic ?? getAnthropic;
  const model = tiers.thinking.model;
  const span = deps.trace?.span({
    name: "agent:world-builder",
    input: parsed,
    metadata: { model, tier: "thinking" },
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
      const client = anthropic();
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: `${userContent}${reminder}` }],
      });

      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const raw = textBlocks.map((b) => b.text).join("");
      if (!raw.trim()) throw new Error("empty response");

      const validated = WorldBuilderOutput.parse(JSON.parse(extractJson(raw)));
      span?.end({ output: validated, metadata: { attempt } });
      return validated;
    } catch (err) {
      lastError = err;
      logger("warn", "WorldBuilder attempt failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger("error", "WorldBuilder fell back to CLARIFY after retry", {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  span?.end({
    output: CLARIFY_FALLBACK,
    metadata: {
      fallback: true,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
  return CLARIFY_FALLBACK;
}
