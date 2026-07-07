/**
 * Exemplar regeneration tooling (§4.7): drafts candidate passages for an
 * axis/band/show through the metered pipeline, printing YAML for review.
 * The shipped v0 library was authored directly (method: synthesized,
 * author: claude-fable-5); this script exists for M2's full-coverage
 * build-out and for regenerating passages the skim or the judge rejects.
 *
 * Usage: pnpm exec tsx --env-file=.env.local scripts/generate-exemplars.ts <axis> <band> "<show>"
 */
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { loadAnchors } from "@/lib/rules/grounding";
import { AxisName, Band } from "@/lib/types/grounding";
import { z } from "zod";

const [axisArg, bandArg, showArg] = process.argv.slice(2);
const axis = AxisName.parse(axisArg);
const band = Band.parse(Number(bandArg));
const show = z.string().min(2).parse(showArg);

const anchor = loadAnchors().find((a) => a.axis === axis);
if (!anchor) throw new Error(`no anchor file for axis ${axis}`);

const Draft = z.object({
  passages: z.array(z.string()).min(2).max(3),
});

// Opus for craft; this is content tooling, not player-facing narration.
const selection = { ...DEV_TIER_SELECTION, judgment: "claude-opus-4-8" as const };

const result = await callJudgment(selection, {
  name: "generate_exemplars",
  schema: Draft,
  system: [
    "You write ORIGINAL pastiche passages for a story engine's grounding library.",
    "Hard rules: 80–150 words each; unmistakably in the named show's prose register;",
    "no canon character names or events (original material only — legal posture §4.7);",
    "the passage must exemplify the target band of the target axis so strongly that a",
    "blind judge would place it there.",
  ].join(" "),
  prompt: [
    `Axis: ${axis} — ${anchor.scale}`,
    `Target band: ${band} of 10`,
    `Register: ${show}`,
    "",
    "Write 2–3 candidate passages.",
  ].join("\n"),
  maxTokens: 2_000,
});

for (const [i, text] of result.passages.entries()) {
  console.log(`  - id: ${axis}_b${band}_candidate${i + 1}`);
  console.log(`    axis: ${axis}`);
  console.log(`    band: ${band}`);
  console.log(`    anchor_show: ${show}`);
  console.log("    author: generate-exemplars");
  console.log("    method: synthesized");
  console.log("    text: >-");
  for (const line of text.match(/.{1,72}(\s|$)/g) ?? [text]) {
    console.log(`      ${line.trim()}`);
  }
  console.log();
}
await flushLangfuse();
