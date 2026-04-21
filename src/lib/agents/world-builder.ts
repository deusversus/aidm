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

/**
 * WB reshape (v3-parity Phase 6B, locked 2026-04-20 per
 * memory/project_worldbuilder_as_editor.md): REJECT is gone. Default
 * is ACCEPT. CLARIFY fires only for local physical ambiguity (scene
 * can't literally render the assertion as-written). FLAG is new —
 * accept the assertion, but surface a craft concern for Chronicler /
 * Director to weigh.
 */
export const WorldBuilderDecision = z.enum(["ACCEPT", "CLARIFY", "FLAG"]);

/**
 * Structured entity update. Shape varies by kind — prompt schema
 * documents the field set per kind. Zod is permissive here (record
 * of string→unknown for type-specific fields) so Chronicler can
 * consume the richest shape the model produces, while downstream
 * typed writes validate-in-depth at the tool boundary.
 */
export const EntityUpdate = z.object({
  kind: z.enum(["npc", "item", "location", "faction", "fact"]),
  name: z.string(),
  /** v3-parity: free-form summary string. Coexists with structured
   * fields for forward compatibility. */
  details: z.string().default(""),
  // NPC-specific
  /** v3-parity NPCDetails.role (ally / rival / mentor / enemy / neutral /
   * acquaintance). Phase 6 audit found this missing from the plan's
   * enumeration; WB outputs now carry role through to register_npc. */
  role: z.string().optional(),
  personality: z.string().optional(),
  goals: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  faction: z.string().nullable().optional(),
  visual_tags: z.array(z.string()).optional(),
  knowledge_topics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).optional(),
  power_tier: z.string().optional(),
  ensemble_archetype: z.string().nullable().optional(),
  // Location-specific
  description: z.string().optional(),
  atmosphere: z.string().optional(),
  notable_features: z.array(z.string()).optional(),
  faction_owner: z.string().nullable().optional(),
  // Faction-specific
  leadership: z.string().optional(),
  allegiance: z.string().optional(),
  // Item-specific
  properties: z.array(z.string()).optional(),
});
export type EntityUpdate = z.infer<typeof EntityUpdate>;

/**
 * Non-blocking craft advisory surfaced alongside an ACCEPT. Chronicler
 * + Director read these; player sees only the `response` prose.
 */
export const WorldBuilderFlag = z.object({
  concern: z.string().min(1),
  severity: z.enum(["minor", "worth_watching"]).default("minor"),
});
export type WorldBuilderFlag = z.infer<typeof WorldBuilderFlag>;

export const WorldBuilderOutput = z.object({
  decision: WorldBuilderDecision,
  response: z.string().min(1),
  entityUpdates: z.array(EntityUpdate).default([]),
  flags: z.array(WorldBuilderFlag).default([]),
  rationale: z.string(),
});
export type WorldBuilderOutput = z.infer<typeof WorldBuilderOutput>;

const CLARIFY_FALLBACK: WorldBuilderOutput = {
  decision: "CLARIFY",
  response:
    "Something about the way you've told it isn't quite settling into the scene yet. Tell me more — when, where, how?",
  entityUpdates: [],
  flags: [],
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
