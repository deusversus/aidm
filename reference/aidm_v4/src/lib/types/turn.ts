import { z } from "zod";

/**
 * Scaffolded M1 types. Shape matches ROADMAP §5 spec. Filled in with full
 * business rules when the agents that produce them land at M1. Exists at
 * M0 so M1 can `import { IntentOutput } from "@/lib/types"` without rewiring.
 */

export const IntentType = z.enum([
  "DEFAULT",
  "COMBAT",
  "SOCIAL",
  "EXPLORATION",
  "ABILITY",
  "INVENTORY",
  "WORLD_BUILDING",
  "META_FEEDBACK",
  "OVERRIDE_COMMAND",
  "OP_COMMAND",
]);

/**
 * Coerce null → undefined for optional string fields. Haiku (and Opus)
 * sometimes emits `null` when the prompt says "omit when unknown" —
 * same loose-JSON pattern that bit WB. Prod log 2026-04-23 turn 9
 * showed IntentClassifier wasting a retry attempt on `target: null`.
 * Keep the prompt honest + survive slips gracefully.
 */
const nullableOptionalString = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.string().optional(),
);

export const IntentOutput = z.object({
  intent: IntentType,
  target: nullableOptionalString,
  action: nullableOptionalString,
  epicness: z.number().min(0).max(1),
  special_conditions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  secondary_intent: IntentType.optional(),
});

export type IntentOutput = z.infer<typeof IntentOutput>;

export const NarrativeWeight = z.enum(["MINOR", "SIGNIFICANT", "CLIMACTIC"]);
export type NarrativeWeight = z.infer<typeof NarrativeWeight>;
export const SuccessLevel = z.enum([
  "critical_failure",
  "failure",
  "partial_success",
  "success",
  "critical_success",
]);

export const OutcomeOutput = z.object({
  success_level: SuccessLevel,
  // D&D-ish bound. Prompt documents 1–30; Zod enforces it so a
  // hallucinated "difficulty_class: 999" fails parse and triggers
  // retry/fallback rather than poisoning the turn record.
  difficulty_class: z.number().int().min(1).max(30),
  modifiers: z.array(z.string()).default([]),
  narrative_weight: NarrativeWeight,
  consequence: z.string().optional(),
  cost: z.string().optional(),
  rationale: z.string(),
});

export type OutcomeOutput = z.infer<typeof OutcomeOutput>;
