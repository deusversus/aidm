import { getPrompt } from "@/lib/prompts";
import type { IntentOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * Director — thinking-tier arc conductor.
 *
 * The macro-supervisor. Runs at campaign startup (post-SZ), at session
 * boundaries, and on hybrid mid-session triggers (every 3+ turns at
 * epicness ≥ 0.6). Produces the arc plan, foreshadowing lifecycle
 * updates, spotlight debt, the voice_patterns journal KA reads in
 * Block 1, and a handful of director_notes KA may honor.
 *
 * Director does NOT narrate and does NOT see individual tokens of
 * prose — it works from turn summaries. KA is the author; Director is
 * the showrunner deciding what shape the next arc wants.
 *
 * Invocation is NOT wired into the turn loop here — post-turn
 * background workers (Commit 7) fire Director on the appropriate
 * triggers. This module exists so those workers have something to
 * call and so `voice_patterns_journal` can flow into Block 1 as soon
 * as there is a journal to flow.
 */

export const ArcPhase = z.enum(["setup", "development", "complication", "crisis", "resolution"]);
export type ArcPhase = z.infer<typeof ArcPhase>;

export const ArcMode = z.enum([
  "main_arc",
  "ensemble_arc",
  "adversary_ensemble_arc",
  "ally_ensemble_arc",
  "investigator_arc",
  "faction_arc",
]);
export type ArcMode = z.infer<typeof ArcMode>;

export const DirectorTrigger = z.enum(["startup", "session_boundary", "hybrid"]);
export type DirectorTrigger = z.infer<typeof DirectorTrigger>;

const ArcPlanSchema = z.object({
  current_arc: z.string(),
  arc_phase: ArcPhase,
  arc_mode: ArcMode,
  arc_pov_protagonist: z.string().nullable().default(null),
  arc_transition_signal: z.string(),
  tension_level: z.number().min(0).max(1),
  planned_beats: z.array(z.string()).min(1),
});

const PlantSchema = z.object({
  name: z.string(),
  description: z.string(),
  payoff_window_min: z.number().int().min(1),
  payoff_window_max: z.number().int().min(1),
  depends_on: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
});

const RetireSchema = z.object({
  id: z.string(),
  status: z.enum(["RESOLVED", "ABANDONED"]),
  reason: z.string(),
});

const ForeshadowingSchema = z.object({
  plant: z.array(PlantSchema).default([]),
  retire: z.array(RetireSchema).default([]),
});

const SpotlightDebtSchema = z.object({
  per_npc: z.record(z.string(), z.number().int()).default({}),
});

const VoicePatternsSchema = z.object({
  patterns: z.array(z.string()).default([]),
});

const RecentTurnSummary = z.object({
  turn_number: z.number().int(),
  summary: z.string(),
  intent: z.custom<IntentOutput>().optional(),
});

const ActiveSeed = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["PLANTED", "GROWING", "CALLBACK", "RESOLVED", "ABANDONED", "OVERDUE"]),
  age_turns: z.number().int().min(0).default(0),
});

export const DirectorInput = z.object({
  trigger: DirectorTrigger,
  /** Required on startup; omitted on other triggers. */
  openingStatePackage: z.unknown().optional(),
  recentTurns: z.array(RecentTurnSummary).default([]),
  currentArcPlan: ArcPlanSchema.nullable().default(null),
  activeSeeds: z.array(ActiveSeed).default([]),
  currentVoicePatterns: VoicePatternsSchema.default(() => ({ patterns: [] })),
});
export type DirectorInput = z.input<typeof DirectorInput>;

export const DirectorOutput = z.object({
  arcPlan: ArcPlanSchema,
  foreshadowing: ForeshadowingSchema,
  spotlightDebt: SpotlightDebtSchema,
  voicePatterns: VoicePatternsSchema,
  directorNotes: z.array(z.string()).default([]),
  rationale: z.string(),
});
export type DirectorOutput = z.infer<typeof DirectorOutput>;

function buildUserContent(input: z.output<typeof DirectorInput>): string {
  const recent = input.recentTurns.length
    ? input.recentTurns
        .map((t) => `  - Turn ${t.turn_number} [${t.intent?.intent ?? "?"}]: ${t.summary}`)
        .join("\n")
    : "  (none)";
  const seeds = input.activeSeeds.length
    ? input.activeSeeds
        .map((s) => `  - ${s.id} "${s.name}" ${s.status} (age ${s.age_turns})`)
        .join("\n")
    : "  (none)";
  const patterns = input.currentVoicePatterns.patterns.length
    ? input.currentVoicePatterns.patterns.map((p) => `  - ${p}`).join("\n")
    : "  (empty — new campaign)";
  const arcPlan = input.currentArcPlan ? JSON.stringify(input.currentArcPlan) : "(none)";
  const osp =
    input.trigger === "startup" && input.openingStatePackage
      ? JSON.stringify(input.openingStatePackage)
      : "(not applicable)";
  return [
    `trigger: ${input.trigger}`,
    `openingStatePackage: ${osp}`,
    "recentTurns:",
    recent,
    "activeSeeds:",
    seeds,
    `currentArcPlan: ${arcPlan}`,
    "currentVoicePatterns:",
    patterns,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

/**
 * Director's fallback: empty journal + neutral arc-plan shell. Safe to
 * persist — KA's Block 1 renders empty voice_patterns verbatim and
 * pacing-agent tolerates an empty planned_beats array.
 */
function fallbackDirectorOutput(): DirectorOutput {
  return {
    arcPlan: {
      current_arc: "(unset — director unavailable)",
      arc_phase: "setup",
      arc_mode: "main_arc",
      arc_pov_protagonist: null,
      arc_transition_signal: "(not set)",
      tension_level: 0.4,
      planned_beats: ["(director unavailable — continue from the last landed beat)"],
    },
    foreshadowing: { plant: [], retire: [] },
    spotlightDebt: { per_npc: {} },
    voicePatterns: { patterns: [] },
    directorNotes: [],
    rationale: "director fallback — service unavailable; returning empty journal",
  };
}

export async function runDirector(
  input: DirectorInput,
  deps: AgentRunnerDeps = {},
): Promise<DirectorOutput> {
  const parsed = DirectorInput.parse(input);
  return runStructuredAgent(
    {
      agentName: "director",
      tier: "thinking",
      systemPrompt: getPrompt("agents/director").content,
      userContent: buildUserContent(parsed),
      outputSchema: DirectorOutput,
      fallback: fallbackDirectorOutput(),
      thinkingBudget: 8192,
      maxTokens: 16384,
    },
    deps,
  );
}

/**
 * Render the voice-patterns journal into the prose form Block 1 of
 * KA's system prompt consumes. Empty patterns → empty string;
 * renderKaBlocks falls back to its own "(empty — Director has not yet
 * built a voice journal)" placeholder in that case.
 */
export function renderVoicePatternsJournal(patterns: readonly string[]): string {
  if (patterns.length === 0) return "";
  const lines = patterns.map((p) => `- ${p}`);
  return ["The player has responded to:", ...lines].join("\n");
}
