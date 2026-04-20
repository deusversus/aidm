import { getPrompt } from "@/lib/prompts";
import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * CombatAgent — thinking-tier consultant for COMBAT intents.
 *
 * Resolves the mechanical outcome of an attack attempt before KA
 * narrates, so KA narrates facts instead of inventing them. Rules-lite
 * at M1; tuned per combat_style at M5.
 */

const PowerTier = z.enum(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]);

export const CombatStyle = z.enum(["tactical", "spectacle", "comedy", "spirit", "narrative"]);
export type CombatStyle = z.infer<typeof CombatStyle>;

const CombatantSchema = z.object({
  name: z.string(),
  tier: PowerTier,
  hp: z.number().nullable().default(null),
  abilities: z.array(z.string()).default([]),
  status_effects: z.array(z.string()).default([]),
});

const RecentCombatTurnSchema = z.object({
  turn: z.number(),
  summary: z.string(),
});

const PowerDistributionSchema = z.object({
  peak_tier: PowerTier,
  typical_tier: PowerTier,
  floor_tier: PowerTier,
  gradient: z.enum(["spike", "top_heavy", "flat", "compressed"]),
});

export const CombatAgentInput = z.object({
  attacker: CombatantSchema,
  defender: CombatantSchema,
  action: z.string().min(1),
  environment: z.array(z.string()).default([]),
  combatStyle: CombatStyle.default("narrative"),
  powerDistribution: PowerDistributionSchema.optional(),
  recentCombatTurns: z.array(RecentCombatTurnSchema).default([]),
});
export type CombatAgentInput = z.input<typeof CombatAgentInput>;

export const CombatResolution = z.enum(["hit", "miss", "glancing", "crit", "counter", "stalemate"]);
export type CombatResolution = z.infer<typeof CombatResolution>;

export const CombatAgentOutput = z.object({
  resolution: CombatResolution,
  damage: z.number().min(0).max(10).nullable(),
  resourceCost: z.object({ type: z.string(), amount: z.number() }).nullable(),
  statusChange: z.array(z.string()).default([]),
  facts: z.array(z.string()).min(1).max(6),
  rationale: z.string(),
});
export type CombatAgentOutput = z.infer<typeof CombatAgentOutput>;

function buildUserContent(input: z.output<typeof CombatAgentInput>): string {
  const envStr = input.environment.length
    ? input.environment.map((e) => `  - ${e}`).join("\n")
    : "  (none)";
  const recent = input.recentCombatTurns.length
    ? input.recentCombatTurns.map((t) => `  - turn ${t.turn}: ${t.summary}`).join("\n")
    : "  (fresh engagement)";
  return [
    `combatStyle: ${input.combatStyle}`,
    input.powerDistribution
      ? `powerDistribution: peak=${input.powerDistribution.peak_tier} typical=${input.powerDistribution.typical_tier} floor=${input.powerDistribution.floor_tier} gradient=${input.powerDistribution.gradient}`
      : "powerDistribution: (not supplied)",
    "",
    `attacker: ${input.attacker.name} (${input.attacker.tier})`,
    `  abilities: ${input.attacker.abilities.join(", ") || "(none listed)"}`,
    `  status: ${input.attacker.status_effects.join(", ") || "(none)"}`,
    `defender: ${input.defender.name} (${input.defender.tier})`,
    `  abilities: ${input.defender.abilities.join(", ") || "(none listed)"}`,
    `  status: ${input.defender.status_effects.join(", ") || "(none)"}`,
    "",
    "environment:",
    envStr,
    "",
    "recentCombatTurns:",
    recent,
    "",
    `action: ${input.action}`,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export async function resolveCombat(
  input: CombatAgentInput,
  deps: AgentRunnerDeps = {},
): Promise<CombatAgentOutput> {
  const parsed = CombatAgentInput.parse(input);
  // Fallback: stalemate with a neutral fact set. Don't fabricate damage
  // or status when the consultant is unavailable; KA will narrate the
  // exchange as unresolved rather than injecting mechanical fiction.
  const fallback: CombatAgentOutput = {
    resolution: "stalemate",
    damage: null,
    resourceCost: null,
    statusChange: [],
    facts: [
      `${parsed.attacker.name} and ${parsed.defender.name} remain locked in the exchange; no decisive result.`,
    ],
    rationale: "combat fallback — consultant unavailable; returning unresolved state",
  };
  return runStructuredAgent(
    {
      agentName: "combat-agent",
      tier: "thinking",
      systemPrompt: getPrompt("agents/combat-agent").content,
      promptId: "agents/combat-agent",
      userContent: buildUserContent(parsed),
      outputSchema: CombatAgentOutput,
      fallback,
      maxTokens: 768,
    },
    deps,
  );
}
