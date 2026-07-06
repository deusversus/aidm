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
/**
 * Opus tolerates prompt instructions well but slips occasionally on
 * loose-JSON habits: a single-item list rendered as a bare string
 * ("to expand" instead of ["to expand"]), a null where the prompt
 * says "omit when unknown." Prod logs 2026-04-22 showed WB falling
 * back to CLARIFY purely from these. A couple of Zod preprocess
 * helpers coerce the loose shapes into the strict ones at parse
 * time — the prompt still asks for clean shapes, but we survive
 * the slips gracefully.
 */
const coerceStringList = z.preprocess((v) => {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v;
  return v;
}, z.array(z.string()).optional());

const coerceOptionalStringDropNull = z.preprocess((v) => {
  if (v === null) return undefined;
  return v;
}, z.string().optional());

/**
 * `knowledge_topics` is a `Record<string, "expert" | "moderate" | "basic">`.
 * Opus sometimes emits it as an array instead (prod log 2026-04-22 turn 7):
 *
 *   Array of objects:  [{ topic: "ratcatching", level: "expert" }, ...]
 *   Array of objects:  [{ name: "X", expertise: "basic" }, ...]
 *   Array of strings:  ["ratcatching", "fencing"]  (no level inferable)
 *
 * Coerce each to the record shape. For the bare-string case we assume
 * "basic" as the conservative default — the model knew the NPC had
 * knowledge in the area, just didn't specify depth.
 */
const LEVELS = ["expert", "moderate", "basic"] as const;
type Level = (typeof LEVELS)[number];
function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

const coerceKnowledgeTopics = z.preprocess((v) => {
  if (v === null || v === undefined) return undefined;
  // Already a record — let Zod validate downstream.
  if (typeof v === "object" && !Array.isArray(v)) return v;
  // Array shapes.
  if (Array.isArray(v)) {
    const record: Record<string, Level> = {};
    for (const item of v) {
      if (typeof item === "string") {
        record[item] = "basic";
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const topic =
          (typeof obj.topic === "string" && obj.topic) ||
          (typeof obj.name === "string" && obj.name) ||
          (typeof obj.subject === "string" && obj.subject);
        const rawLevel = obj.level ?? obj.expertise ?? obj.depth ?? "basic";
        if (topic) {
          record[topic] = isLevel(rawLevel) ? rawLevel : "basic";
        }
      }
    }
    return record;
  }
  return v;
}, z.record(z.string(), z.enum(LEVELS)).optional());

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
  goals: coerceStringList,
  secrets: coerceStringList,
  faction: z.string().nullable().optional(),
  visual_tags: coerceStringList,
  knowledge_topics: coerceKnowledgeTopics,
  power_tier: z.string().optional(),
  ensemble_archetype: z.string().nullable().optional(),
  // Location-specific
  description: z.string().optional(),
  atmosphere: z.string().optional(),
  notable_features: coerceStringList,
  faction_owner: z.string().nullable().optional(),
  // Faction-specific
  leadership: coerceOptionalStringDropNull,
  allegiance: coerceOptionalStringDropNull,
  // Item-specific
  properties: coerceStringList,
});
export type EntityUpdate = z.infer<typeof EntityUpdate>;

/**
 * Non-blocking craft advisory — discriminated union of three types
 * (WB reshape commit, closing the 2026-04-20 design delta). Each type
 * carries category-specific fields so the sidebar UI can render
 * specific copy rather than a generic "flag" badge the author learns
 * to ignore.
 *
 *   - voice_fit: tonal / register misalignment. Jinwoo-in-Bebop.
 *     Non-fatal but the scene may read flat without adjustment.
 *   - stakes_implication: a move that dissolves or compresses the
 *     current arc's tension. Accepting it is the author's call;
 *     this flag surfaces the cost.
 *   - internal_consistency: contradicts the player's OWN prior canon
 *     (not source canon — source contradictions belong on canonicalityMode).
 *     Shows the specific contradiction so the author can retcon
 *     deliberately or revise.
 */
export const VoiceFitFlag = z.object({
  kind: z.literal("voice_fit"),
  /** The clashing element — "galactic empire spanning ten millennia" in a Bebop campaign. */
  evidence: z.string().min(1),
  /** How the author could soften without losing the intended beat. */
  suggestion: z.string().min(1),
});
export type VoiceFitFlag = z.infer<typeof VoiceFitFlag>;

export const StakesImplicationFlag = z.object({
  kind: z.literal("stakes_implication"),
  /** The move itself — "Spike reveals he's immortal." */
  evidence: z.string().min(1),
  /** The tension being collapsed — "the next three arc beats around mortality." */
  what_dissolves: z.string().min(1),
});
export type StakesImplicationFlag = z.infer<typeof StakesImplicationFlag>;

export const InternalConsistencyFlag = z.object({
  kind: z.literal("internal_consistency"),
  /** The current-turn assertion — "the gates are ancient." */
  evidence: z.string().min(1),
  /** The prior fact it contradicts — "turn 1 framing: gates opened 10 years ago." */
  contradicts: z.string().min(1),
});
export type InternalConsistencyFlag = z.infer<typeof InternalConsistencyFlag>;

export const WorldBuilderFlag = z.discriminatedUnion("kind", [
  VoiceFitFlag,
  StakesImplicationFlag,
  InternalConsistencyFlag,
]);
export type WorldBuilderFlag = z.infer<typeof WorldBuilderFlag>;

export const WorldBuilderOutput = z.object({
  decision: WorldBuilderDecision,
  response: z.string().min(1),
  entityUpdates: z.array(EntityUpdate).default([]),
  flags: z.array(WorldBuilderFlag).default([]),
  rationale: z.string(),
});
export type WorldBuilderOutput = z.infer<typeof WorldBuilderOutput>;

/**
 * WB fallback when the LLM call fails retry budget (WB reshape 2026-04-22).
 *
 * **ACCEPT, not CLARIFY.** In authorship tooling the safe default for
 * "we couldn't run the editor successfully" is: accept the assertion
 * silently and let KA narrate forward with it as canon. CLARIFY on
 * failure was a gatekeeper-era instinct — blocking a narrative turn
 * because WB couldn't do its editor pass is the opposite of what this
 * subsystem is for.
 *
 * The decision carries no entityUpdates + no flags — we don't know
 * what the author declared, so we don't pre-register anything. KA
 * narrates the assertion directly from the raw playerMessage (which
 * already flowed into Block 4 as player_message); Chronicler's
 * post-turn pass catalogs any entities KA renders.
 *
 * `response` is brief + in-character, surfaced to KA via Block 4's
 * `wb_acknowledgment` slot — not shown to the player directly.
 */
const ACCEPT_FALLBACK: WorldBuilderOutput = {
  decision: "ACCEPT",
  response: "Noted. The world bends accordingly.",
  entityUpdates: [],
  flags: [],
  rationale: "WorldBuilder fallback: retry budget exhausted; accepting silently.",
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
      fallback: ACCEPT_FALLBACK,
      // Long worldbuilding assertions (multi-paragraph exposition)
      // need headroom — 1024 was truncating some Opus outputs.
      maxTokens: 2048,
      spanInput: parsed,
    },
    deps,
  );
}
