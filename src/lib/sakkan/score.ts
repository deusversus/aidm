import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { loadGrounding } from "@/lib/rules/grounding";
import { type AxisName, COVERED_AXES } from "@/lib/types/grounding";
import { z } from "zod";

/**
 * The shared blind axis scorer — Gauge v1 (§4.5 thinned per §12: blind to
 * active values and axis-definition-prompted; excerpt-anchored scoring and
 * reliability calibration are the M2 Gauge-v2 acquisitions). ONE
 * implementation, two consumers: the renderer-efficacy eval (§10.2) and
 * C8's runtime Sakkan — two diverging scorers would make the eval measure
 * nothing.
 *
 * Gap-rule enforcement: refuses to score an uncovered axis.
 */

export const AxisScore = z.object({
  axis: z.string(),
  score: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  /** Short quoted phrase from the sample that carried the read. */
  evidence_span: z.string(),
});
export type AxisScore = z.infer<typeof AxisScore>;

const ScoreSheet = z.object({ scores: z.array(AxisScore) });

export interface ScoreOptions {
  /** KA prose only — players' text excluded (§4.5). */
  sample: string;
  axes: AxisName[];
  name?: string;
  campaignId?: string;
  turnNumber?: number;
}

export async function scoreAxes(
  selection: TierSelection,
  opts: ScoreOptions,
): Promise<AxisScore[]> {
  const uncovered = opts.axes.filter((a) => !COVERED_AXES.includes(a));
  if (uncovered.length > 0) {
    throw new Error(`scoreAxes: uncovered axes ${uncovered.join(", ")} (grounding-gap rule)`);
  }
  const { anchors } = loadGrounding();
  const axisBlock = opts.axes
    .map((axis) => {
      const anchor = anchors.find((a) => a.axis === axis);
      return `- ${axis}: ${anchor?.scale ?? axis}`;
    })
    .join("\n");

  const result = await callJudgment(selection, {
    name: opts.name ?? "sakkan_score",
    schema: ScoreSheet,
    system: [
      "You are the Sakkan (animation director) for a prose story engine: you score",
      "a prose sample on tonal axes, 0-10, from the TEXT ALONE. You are never told",
      "what the target values are — score what is on the page, not what you guess",
      "was intended. For each axis give a confidence (how legible this axis is in",
      "this sample) and quote the short span that most carried your read.",
    ].join(" "),
    prompt: `Axes (each 0–10):\n${axisBlock}\n\nProse sample:\n---\n${opts.sample}\n---\nScore every listed axis.`,
    effort: "low",
    maxTokens: 6_000,
    campaignId: opts.campaignId,
    turnNumber: opts.turnNumber,
  });
  const wanted = new Set<string>(opts.axes);
  return result.scores.filter((s) => wanted.has(s.axis));
}
