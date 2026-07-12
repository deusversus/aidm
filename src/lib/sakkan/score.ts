import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { loadGrounding } from "@/lib/rules/grounding";
import { type AnchorFile, type AxisName, COVERED_AXES, type Exemplar } from "@/lib/types/grounding";
import { z } from "zod";

/**
 * The shared blind axis scorer — Gauge v2 (§4.5, §4.6): now excerpt-anchored.
 * The per-axis prompt block carries the axis's 0↔10 scale, its band witnesses
 * (shows at bands 1/5/9), and the two extreme exemplar excerpts — the C6
 * library the Sakkan finally gets to stand on. Still BLIND: the anchors say
 * what each band READS like, never what THIS story is aiming for. ONE
 * implementation, two consumers: the renderer-efficacy eval (§10.2) and the
 * runtime Sakkan — two diverging scorers would make the eval measure nothing.
 *
 * Gap-rule enforcement: refuses to score an uncovered axis. The anchored block
 * is per-axis, so it also refuses to score more than MAX_SCORED_AXES at once —
 * a whole-charter score would multiply prompt cost past the budget.
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

/**
 * Blind-protocol invariant (§4.5): NO field here can carry the values the
 * story is aiming for — only the prose, the axis list, and trace/telemetry
 * ids. A `target`/`active`/`wanted`/`premise` field would smuggle intent past
 * the anchors; the type-level guard in score.test.ts pins the key set.
 */
export interface ScoreOptions {
  /** KA prose only — players' text excluded (§4.5). */
  sample: string;
  axes: AxisName[];
  name?: string;
  campaignId?: string;
  turnNumber?: number;
}

/**
 * Hard cap on axes per scoring call. The anchored block (band witnesses + two
 * excerpts) is rendered PER AXIS, so it multiplies the prompt. A Sakkan sample
 * scores the ~6 rendered axes; more than this is a caller bug (a whole-charter
 * score), and we throw rather than silently truncate the request.
 */
export const MAX_SCORED_AXES = 8;

/** Excerpt clip length (~120 chars, word-boundary) — enough register to anchor a band, cheap enough to render two per axis. */
const EXCERPT_CLIP = 120;

/** Whitespace-flattened, clipped to ~max chars at a word boundary, …-suffixed. */
function clipExcerpt(text: string, max = EXCERPT_CLIP): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The per-axis anchored prompt block (§4.6): the 0↔10 scale line, then what
 * bands 1/5/9 FEEL like (first two witness shows each), then what the two
 * extremes READ like (the clipped exemplar excerpts). Blind by construction —
 * it describes the scale, never the story's intent.
 */
function anchoredAxisBlock(
  anchor: AnchorFile | undefined,
  axis: AxisName,
  byId: Map<string, Exemplar>,
): string {
  if (!anchor) return `- ${axis}: ${axis}`;
  const lines = [`- ${axis}: ${anchor.scale}`];
  for (const band of ["1", "5", "9"] as const) {
    const witnesses = anchor.bands[band].shows
      .slice(0, 2)
      .map((s) => `${s.title} (${s.note})`)
      .join("; ");
    lines.push(`  ${band} feels like: ${witnesses}`);
  }
  for (const band of ["1", "9"] as const) {
    const ref = anchor.bands[band].excerpt_ref;
    const ex = ref ? byId.get(ref) : undefined;
    if (ex) lines.push(`  a ${band} reads like: "${clipExcerpt(ex.text)}"`);
  }
  return lines.join("\n");
}

export async function scoreAxes(
  selection: TierSelection,
  opts: ScoreOptions,
): Promise<AxisScore[]> {
  if (opts.axes.length > MAX_SCORED_AXES) {
    throw new Error(
      `scoreAxes: ${opts.axes.length} axes exceeds MAX_SCORED_AXES=${MAX_SCORED_AXES} — the anchored block is per-axis; a Sakkan sample scores ~6`,
    );
  }
  const uncovered = opts.axes.filter((a) => !COVERED_AXES.includes(a));
  if (uncovered.length > 0) {
    throw new Error(`scoreAxes: uncovered axes ${uncovered.join(", ")} (grounding-gap rule)`);
  }
  const { anchors, byId } = loadGrounding();
  const axisBlock = opts.axes
    .map((axis) =>
      anchoredAxisBlock(
        anchors.find((a) => a.axis === axis),
        axis,
        byId,
      ),
    )
    .join("\n\n");

  const result = await callJudgment(selection, {
    name: opts.name ?? "sakkan_score",
    schema: ScoreSheet,
    system: [
      "You are the Sakkan (animation director) for a prose story engine: you score",
      "a prose sample on tonal axes, 0-10, from the TEXT ALONE. Each axis carries",
      "witness shows and two extreme excerpts that calibrate what its bands READ",
      "like — anchors for the scale, never a statement of what THIS story is aiming",
      "for. You are never shown the values the story is reaching for; read what is on",
      "the page, not what you guess was intended. For each axis give a confidence",
      "(how legible this axis is in this sample) and quote the short span that most",
      "carried your read.",
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
