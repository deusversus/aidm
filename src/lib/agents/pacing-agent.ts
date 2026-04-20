import { getPrompt } from "@/lib/prompts";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * PacingAgent — thinking-tier advisor on arc-beat rhythm.
 *
 * KA invokes when deciding whether this beat should escalate, hold,
 * release, pivot, set up, pay off, or detour. Reads the arc plan
 * (empty until Director runs) + recent tension curve.
 */

export const BeatDirective = z.enum([
  "escalate",
  "hold",
  "release",
  "pivot",
  "setup",
  "payoff",
  "detour",
]);
export type BeatDirective = z.infer<typeof BeatDirective>;

const RecentBeatSchema = z.object({
  directive: BeatDirective,
  epicness: z.number().min(0).max(1),
});

const ForeshadowingSeedSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["PLANTED", "GROWING", "CALLBACK", "RESOLVED", "ABANDONED", "OVERDUE"]),
});

export const PacingAgentInput = z.object({
  arcPlan: z
    .object({
      current_arc: z.string().nullable().default(null),
      arc_phase: z.string().nullable().default(null),
      planned_beats: z.array(z.string()).default([]),
    })
    .default(() => ({ current_arc: null, arc_phase: null, planned_beats: [] })),
  recentTensionCurve: z.array(RecentBeatSchema).default([]),
  activeForeshadowing: z.array(ForeshadowingSeedSchema).default([]),
  intent: z.custom<IntentOutput>().optional(),
  outcome: z.custom<OutcomeOutput>().optional(),
});
export type PacingAgentInput = z.input<typeof PacingAgentInput>;

export const PacingAgentOutput = z.object({
  directive: BeatDirective,
  toneTarget: z.string().min(1),
  escalationTarget: z.number().min(0).max(1),
  rationale: z.string(),
});
export type PacingAgentOutput = z.infer<typeof PacingAgentOutput>;

function buildUserContent(input: z.output<typeof PacingAgentInput>): string {
  const beats = input.arcPlan.planned_beats.length
    ? input.arcPlan.planned_beats.map((b) => `  - ${b}`).join("\n")
    : "  (arc plan empty — Director hasn't planned this run yet)";
  const curve = input.recentTensionCurve.length
    ? input.recentTensionCurve
        .map((b, i) => `  - [${i}] ${b.directive} (epicness ${b.epicness.toFixed(2)})`)
        .join("\n")
    : "  (no recent beats)";
  const seeds = input.activeForeshadowing.length
    ? input.activeForeshadowing.map((s) => `  - ${s.id} "${s.name}" (${s.status})`).join("\n")
    : "  (no active seeds)";
  return [
    `arcPlan.current_arc: ${input.arcPlan.current_arc ?? "(none)"}`,
    `arcPlan.arc_phase: ${input.arcPlan.arc_phase ?? "(none)"}`,
    "arcPlan.planned_beats:",
    beats,
    "",
    "recentTensionCurve:",
    curve,
    "",
    "activeForeshadowing:",
    seeds,
    "",
    `intent: ${input.intent ? JSON.stringify(input.intent) : "(not yet decided)"}`,
    `outcome: ${input.outcome ? JSON.stringify(input.outcome) : "(not yet decided)"}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function advisePacing(
  input: PacingAgentInput,
  deps: AgentRunnerDeps = {},
): Promise<PacingAgentOutput> {
  const parsed = PacingAgentInput.parse(input);
  // Fallback: hold-tension advisory. Neutral choice when the advisor is
  // unavailable — doesn't push the scene either direction.
  const fallback: PacingAgentOutput = {
    directive: "hold",
    toneTarget: "steady",
    escalationTarget: 0.5,
    rationale: "pacing fallback — advisor unavailable; hold current tension",
  };
  return runStructuredAgent(
    {
      agentName: "pacing-agent",
      tier: "thinking",
      systemPrompt: getPrompt("agents/pacing-agent").content,
      promptId: "agents/pacing-agent",
      userContent: buildUserContent(parsed),
      outputSchema: PacingAgentOutput,
      fallback,
      maxTokens: 512,
    },
    deps,
  );
}
