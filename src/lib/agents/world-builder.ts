import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

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
 * Routes through the shared runner so provider dispatch follows the
 * campaign's `modelContext` (M1.5). Anthropic-provider campaigns hit
 * Opus via `@anthropic-ai/sdk`; Google-provider campaigns (M3.5+) hit
 * Gemini Pro via `@google/genai`.
 *
 * Failure policy:
 *   - JSON/schema parse failure → runner retries once with stricter
 *     reminder, then falls back to a generic CLARIFY that asks the
 *     player to rephrase in-character (never blocks; never surfaces
 *     the failure).
 *   - Verdict / voice concerns (2026-04-20 review): the current
 *     CLARIFY phrasing breaks scene voice ("Tell me more — when,
 *     where, how?"). WB is being reframed from gatekeeper to editor —
 *     drop REJECT, default ACCEPT, CLARIFY only for local physical
 *     ambiguity. That reshape is tracked separately and applies at
 *     prompt + schema level; this file is the transport shim only.
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

const CLARIFY_FALLBACK: WorldBuilderOutput = {
  decision: "CLARIFY",
  response:
    "Something about the way you've told it isn't quite settling into the scene yet. Tell me more — when, where, how?",
  entityUpdates: [],
  rationale: "WorldBuilder fallback: retry budget exhausted; asking the player to rephrase.",
};

export type WorldBuilderDeps = AgentRunnerDeps;

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

export async function validateAssertion(
  input: WorldBuilderInput,
  deps: WorldBuilderDeps = {},
): Promise<WorldBuilderOutput> {
  const parsed = WorldBuilderInput.parse(input);
  return runStructuredAgent(
    {
      agentName: "world-builder",
      tier: "thinking",
      systemPrompt: getPrompt("agents/world-builder").content,
      promptId: "agents/world-builder",
      userContent: buildUserContent(parsed),
      outputSchema: WorldBuilderOutput,
      fallback: CLARIFY_FALLBACK,
      maxTokens: 1024,
      spanInput: parsed,
    },
    deps,
  );
}
