import { streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { PUNCH_THROUGH_TURNS, renderAmendments } from "@/lib/renderer/amendments";
import { renderSettei } from "@/lib/renderer/settei";
import { scoreAxes } from "@/lib/sakkan/score";
import type { AxisName } from "@/lib/types/grounding";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.2 — Renderer efficacy, LIVE from M1 (risk §14.4's tripwire): the
 * same neutral scene narrated WITH and WITHOUT the Settei; both outputs
 * blind-scored by the shared Gauge-v1 scorer. The charter must move the
 * target axes toward their extremes without dragging the controls.
 * Runs on DEV tiers (never Fable — standing directive).
 */

// Synthetic extreme premise: strong signal on two covered axes. The A/B
// needs HEADROOM: the scene must baseline FAR from every target (first
// live runs failed on this twice — comedy-at-1 against an already-serious
// scene, then darkness-9 against a dust-storm scene Sonnet narrates noir
// unprompted). A cozy, neutral-valence scene baselines low on darkness AND
// comedy, so a 9 on either must visibly bend it.
const TARGETS: { axis: AxisName; value: number }[] = [
  { axis: "darkness", value: 9 },
  { axis: "comedy", value: 9 },
];
const CONTROLS: AxisName[] = ["pacing", "interiority"];

const SCENE =
  "Narrate one short scene (under 200 words): two old friends reopen their family noodle stand after months of repairs, and the first customer of the morning walks in just as the new sign goes up. Then call commit_scene once.";

async function narrate(system: string): Promise<string> {
  const { done } = streamNarration({
    name: "eval_renderer_efficacy",
    selection: DEV_TIER_SELECTION,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: SCENE }],
    maxTokens: 900,
  });
  return (await done()).prose;
}

export const rendererEfficacy: Suite = {
  name: "renderer-efficacy",
  gate: "M1+ (§10.2)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const { bebopContract } = await import("@/lib/renderer/__tests__/fixtures");
    const { DNAScales } = await import("@/lib/types/dna");
    const details: string[] = [];
    const failures: string[] = [];

    // Shared baseline arm: the neutral prompt is target-independent.
    const without = await narrate("You narrate scenes for an interactive story. Write well.");

    for (const t of TARGETS) {
      // One pressure per run: flat-5 treatment except the target, so the
      // rendered charter carries exactly one extreme and the A/B isolates it.
      const contract = bebopContract();
      for (const axis of Object.keys(DNAScales.shape) as AxisName[]) {
        contract.active.treatment[axis] = 5;
      }
      contract.active.treatment[t.axis] = t.value;
      const settei = renderSettei({ contract, marks: [] });

      const withCharter = await narrate(settei.text);
      const axes = [t.axis, ...CONTROLS];
      // Mean-of-2 on the target axis: single-sample scorer noise is ±1,
      // which can swamp a real signal at the margin.
      const [scoresWith, scoresWith2, scoresWithout, scoresWithout2] = await Promise.all([
        scoreAxes(DEV_TIER_SELECTION, {
          sample: withCharter,
          axes,
          name: `efficacy_with_${t.axis}`,
        }),
        scoreAxes(DEV_TIER_SELECTION, {
          sample: withCharter,
          axes: [t.axis],
          name: `efficacy_with2_${t.axis}`,
        }),
        scoreAxes(DEV_TIER_SELECTION, {
          sample: without,
          axes,
          name: `efficacy_without_${t.axis}`,
        }),
        scoreAxes(DEV_TIER_SELECTION, {
          sample: without,
          axes: [t.axis],
          name: `efficacy_without2_${t.axis}`,
        }),
      ]);
      const get = (scores: typeof scoresWith, axis: AxisName) =>
        scores.find((s) => s.axis === axis)?.score;
      const mean = (a?: number, b?: number) =>
        a === undefined ? b : b === undefined ? a : (a + b) / 2;

      const w = mean(get(scoresWith, t.axis), get(scoresWith2, t.axis));
      const wo = mean(get(scoresWithout, t.axis), get(scoresWithout2, t.axis));
      if (w === undefined || wo === undefined) {
        failures.push(`${t.axis}: scorer returned no score`);
        continue;
      }
      const dWith = Math.abs(w - t.value);
      const dWithout = Math.abs(wo - t.value);
      details.push(
        `${t.axis}: target ${t.value} | with ${w} (Δ${dWith}) | without ${wo} (Δ${dWithout})`,
      );
      if (dWith >= dWithout) {
        failures.push(
          `${t.axis}: charter did not move prose toward target (Δ${dWith} ≥ Δ${dWithout})`,
        );
      }
      for (const c of CONTROLS) {
        const cw = get(scoresWith, c);
        const cwo = get(scoresWithout, c);
        if (cw !== undefined && cwo !== undefined && Math.abs(cw - cwo) >= 4) {
          failures.push(`control ${c} drifted ${Math.abs(cw - cwo)} under the ${t.axis} charter`);
        }
      }
    }

    // --- Corrective punch-through (§12, M2-C6) -------------------------------
    // The escalated Amendments note must pull the target axis at least as far
    // as the plain note, and clearly past the no-correction baseline. Isolates
    // the Amendments channel: a flat, pressure-free Settei is the shared base
    // for all three arms, so only the corrective note varies. Directional, not
    // strict (model variance, §0.9) — one band of tolerance on each assertion.
    const PUNCH = { axis: "darkness" as AxisName, active: 9, observed: 3 };
    const flat = bebopContract();
    for (const axis of Object.keys(DNAScales.shape) as AxisName[]) {
      flat.active.treatment[axis] = 5;
    }
    const baseCharter = renderSettei({ contract: flat, marks: [] }).text;
    const note = {
      axis: PUNCH.axis,
      active: PUNCH.active,
      observed: PUNCH.observed,
      since_turn: 1,
    };
    const plainAmend = renderAmendments({ sakkanNotes: [note], freshMarks: [] });
    const escalatedAmend = renderAmendments({
      sakkanNotes: [note],
      freshMarks: [],
      currentTurn: 1 + PUNCH_THROUGH_TURNS,
      // The re-measurement tether (C6 audit #1): a post-note sample happened.
      lastSampleTurn: PUNCH_THROUGH_TURNS,
    });
    const withAmend = (amend: string) => (amend ? `${baseCharter}\n\n${amend}` : baseCharter);

    const [pBaseline, pPlain, pEsc] = await Promise.all([
      narrate(withAmend("")),
      narrate(withAmend(plainAmend.text)),
      narrate(withAmend(escalatedAmend.text)),
    ]);
    // Mean-of-2 on the target axis: single-sample scorer noise (±1) can swamp
    // a one-band signal.
    const scoreTarget = async (prose: string, tag: string) => {
      const [s1, s2] = await Promise.all([
        scoreAxes(DEV_TIER_SELECTION, { sample: prose, axes: [PUNCH.axis], name: `punch_${tag}` }),
        scoreAxes(DEV_TIER_SELECTION, {
          sample: prose,
          axes: [PUNCH.axis],
          name: `punch_${tag}2`,
        }),
      ]);
      const g = (s: typeof s1) => s.find((x) => x.axis === PUNCH.axis)?.score;
      const a = g(s1);
      const b = g(s2);
      return a === undefined ? b : b === undefined ? a : (a + b) / 2;
    };
    const [bScore, plScore, esScore] = await Promise.all([
      scoreTarget(pBaseline, "baseline"),
      scoreTarget(pPlain, "plain"),
      scoreTarget(pEsc, "escalated"),
    ]);
    if (bScore === undefined || plScore === undefined || esScore === undefined) {
      failures.push("punch-through: scorer returned no score");
    } else {
      details.push(
        `punch-through darkness→${PUNCH.active}: baseline ${bScore} | plain ${plScore} | escalated ${esScore}`,
      );
      if (esScore < plScore - 1) {
        failures.push(`punch-through: escalated ${esScore} fell >1 band below plain ${plScore}`);
      }
      if (esScore - bScore < 1) {
        failures.push(
          `punch-through: escalated ${esScore} did not clear baseline ${bScore} by a band`,
        );
      }
    }

    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
