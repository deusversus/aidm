/**
 * C4 smoke: native strict structured output on the judgment tier, traced +
 * metered. Run: pnpm spike:judgment  (~fraction of a cent on Haiku)
 */
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { z } from "zod";

const Verdict = z.object({
  success_level: z.enum(["failure", "partial_success", "success"]),
  difficulty_class: z.number().int().min(1).max(30),
  rationale: z.string(),
});

const result = await callJudgment(DEV_TIER_SELECTION, {
  name: "smoke_judgment",
  schema: Verdict,
  system:
    "You are the outcome judge for an anime-flavored story engine. Judge plausibility with anime logic, not simulationist realism.",
  prompt:
    "A veteran bounty hunter (competent, unarmed) tries to talk his way past a bored dock guard on Ganymede. Judge the outcome.",
  maxTokens: 500,
});

console.log("parsed:", JSON.stringify(result, null, 2));
await flushLangfuse();
console.log("smoke_judgment: OK — check langfuse:latest and the model_calls row");
