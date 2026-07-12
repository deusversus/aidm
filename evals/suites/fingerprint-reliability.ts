import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { loadGrounding } from "@/lib/rules/grounding";
import { scoreAxes } from "@/lib/sakkan/score";
import { COVERED_AXES } from "@/lib/types/grounding";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.1 — fingerprint reliability: the test-retest precision of the Gauge-v2
 * scorer, now that it is excerpt-anchored (C7). For every covered axis we score
 * that axis's band-9 exemplar three times (k=3, one axis per call) and measure
 * the spread. The instrument has to be steadier than the drift band it feeds:
 * if a single axis's sampling noise (sd) rivals DRIFT_THRESHOLD=2, a spike and a
 * real drift are indistinguishable and its corrections cannot be trusted to fire
 * on signal (§4.5 — measured, not vibed).
 *
 * Judged on Sonnet EXPLICITLY (not the DEV Haiku): reliability must measure the
 * scorer AS DEPLOYED — the campaign judgment tier is Sonnet/Opus, and Haiku's
 * band discrimination is not what the live Sakkan runs on.
 *
 * COST: |COVERED_AXES| (24) × k=3 = ~72 Sonnet judgment calls (one axis each;
 * +1 per validation retry). ~$3 at Sonnet rates. The INTEGRATOR runs the meter
 * — do NOT run this in a tuning loop; iterate reliability on fixtures, gate here.
 *
 * The complementary field instrument is the live campaign itself:
 * campaigns.direction_state.sakkan.readings accumulate real deployment reads.
 * This suite measures instrument precision on fixed fixtures; those readings
 * measure precision in deployment. This suite stays hermetic — no DB read.
 */

const K = 3;
// Reliability gate: sampling noise must not swamp the drift band, and the
// scorer must not systematically mis-read a known extreme.
const SD_MAX = 2.0;
const BIAS_MAX = 2.5;
// Below this the drift band's two-consecutive-samples rule is comfortably
// clear of noise; at or above it the band or the anchor wants another look.
const SD_TIGHT = 1.5;

// Judged on Sonnet: see the header — as-deployed, not DEV-Haiku.
const SELECTION = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" as const };

function stats(xs: number[]): { mean: number; sd: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, sd: Math.sqrt(variance) };
}

const signed = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

export const fingerprintReliability: Suite = {
  name: "fingerprint-reliability",
  gate: "M2 (§10.1)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const { exemplars } = loadGrounding();
    const details: string[] = [];
    const failures: string[] = [];

    const perAxis: { axis: string; mean: number; sd: number; bias: number }[] = [];
    const wideAxes: string[] = [];

    for (const axis of COVERED_AXES) {
      const exemplar = exemplars.find((e) => e.axis === axis && e.band === 9);
      if (!exemplar) {
        // The coverage invariant guarantees this exists; a miss is a library bug.
        failures.push(`${axis}: no band-9 exemplar (coverage invariant violated)`);
        continue;
      }

      const reads: number[] = [];
      let scoreFailed = false;
      for (let i = 0; i < K; i++) {
        // One transient API error must not void the whole metered run (C7
        // audit #2) — the axis fails loudly, siblings' stats survive.
        let result: Awaited<ReturnType<typeof scoreAxes>>;
        try {
          result = await scoreAxes(SELECTION, {
            sample: exemplar.text,
            axes: [axis],
            name: `reliability_${axis}_${i + 1}`,
          });
        } catch (err) {
          failures.push(`${axis}: scorer threw on repeat ${i + 1} — ${err}`);
          scoreFailed = true;
          break;
        }
        const score = result.find((r) => r.axis === axis)?.score;
        if (score === undefined) {
          failures.push(`${axis}: scorer returned no score on repeat ${i + 1}`);
          scoreFailed = true;
          break;
        }
        reads.push(score);
      }
      if (scoreFailed) continue;

      const { mean, sd } = stats(reads);
      const bias = mean - 9;
      perAxis.push({ axis, mean, sd, bias });
      details.push(
        `${axis}: mean ${mean.toFixed(2)}, sd ${sd.toFixed(2)}, bias ${signed(bias)} [${reads.join(", ")}]`,
      );

      if (sd >= SD_MAX) {
        failures.push(`${axis}: sd ${sd.toFixed(2)} ≥ ${SD_MAX} (noise swamps the drift band)`);
      }
      if (Math.abs(bias) > BIAS_MAX) {
        failures.push(
          `${axis}: bias ${signed(bias)} (|bias| > ${BIAS_MAX} on the authored-as-band-9 fixture)`,
        );
      }
      if (sd >= SD_TIGHT) wideAxes.push(axis);
    }

    // Aggregate: how steady is the instrument overall, and where is it weakest?
    if (perAxis.length > 0) {
      const meanSd = perAxis.reduce((a, b) => a + b.sd, 0) / perAxis.length;
      const worst = perAxis.reduce((a, b) => (b.sd > a.sd ? b : a));
      details.push(
        `aggregate: mean sd ${meanSd.toFixed(2)} across ${perAxis.length} axes; worst ${worst.axis} sd ${worst.sd.toFixed(2)}`,
      );
      details.push(
        wideAxes.length === 0
          ? "drift band: DRIFT_THRESHOLD=2 stands (every axis sd < 1.5)"
          : `drift band: band review needed: ${wideAxes.join(", ")}`,
      );
    }

    // Static field-complement note (§0.9): this suite measures instrument
    // precision on fixed fixtures; campaigns.direction_state.sakkan.readings are
    // the complementary field data — deployment precision on live play.
    details.push(
      "field complement: live-campaign Sakkan readings (campaigns.direction_state.sakkan.readings) measure deployment precision; this suite measures instrument precision.",
    );

    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
