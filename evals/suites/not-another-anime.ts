import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { loadGrounding } from "@/lib/rules/grounding";
import { z } from "zod";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.6 — the not-another-anime judge, LIVE at M0 because the exemplar
 * library is its first customer: every synthesized passage must (a) sit at
 * its claimed band and (b) be register-specific — recognizably in the
 * anchor show's idiom, not generic anime prose. At M1+ this suite extends
 * to director_personality, Settei charters, and opening scenes.
 */

const Verdict = z.object({
  band_true: z
    .boolean()
    .describe("does the passage genuinely exemplify the claimed band of this axis?"),
  register_specific: z
    .boolean()
    .describe(
      "is the prose register recognizably the claimed show's — NOT interchangeable generic anime prose?",
    ),
  reasoning: z.string().describe("one or two sentences, no more"),
});

// Judged on Sonnet: register discrimination is exactly the judgment this
// eval exists for; Haiku under-discriminates pastiche.
const SELECTION = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" as const };

export const notAnotherAnime: Suite = {
  name: "not-another-anime",
  gate: "M0 (exemplars) → M1+ (charters, personalities, openings)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const { anchors, exemplars } = loadGrounding();
    const details: string[] = [];
    const failures: string[] = [];
    for (const e of exemplars) {
      const anchor = anchors.find((a) => a.axis === e.axis);
      const judge = () =>
        callJudgment(SELECTION, {
          name: "eval_not_another_anime",
          schema: Verdict,
          system: [
            "You judge synthesized pastiche passages for a story engine's grounding library.",
            "SOURCING POLICY (legal): passages are FORBIDDEN from using canon character names,",
            "canon proper nouns, or identifiable canon events. Therefore judge",
            "'register_specific' on PROSE IDIOM ALONE — sentence rhythm, narrative stance,",
            "tonal machinery, humor/dread signature — never on the presence or absence of",
            "franchise vocabulary. Be strict on idiom: fail a passage that could plausibly",
            "come from a generic light novel rather than the claimed show's specific voice.",
          ].join(" "),
          prompt: [
            `Axis: ${e.axis} — ${anchor?.scale ?? ""}`,
            `Claimed band: ${e.band} (0–10 scale)`,
            `Claimed register: ${e.anchor_show}`,
            "",
            "Passage:",
            e.text,
          ].join("\n"),
          // maxTokens covers adaptive thinking + the JSON; effort low keeps
          // the thinking share small for a bounded register check.
          effort: "low",
          maxTokens: 6_000,
        });
      // Error resilience: one retry on a failed CALL. Verdict resilience: a
      // single judge sample is noise at the margin (§4.5's own drift rule
      // demands two consecutive samples) — a failing verdict is confirmed
      // only by majority of three.
      let verdict: z.infer<typeof Verdict>;
      try {
        verdict = await judge().catch(judge);
      } catch (err) {
        failures.push(
          `${e.id}: judge call failed twice — ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      let fails = verdict.band_true && verdict.register_specific ? 0 : 1;
      if (fails > 0) {
        for (let i = 0; i < 2 && fails < 2; i++) {
          try {
            const v = await judge().catch(judge);
            if (!(v.band_true && v.register_specific)) {
              fails++;
              verdict = v;
            }
          } catch {
            // A twice-failed resample CALL yields no verdict either way —
            // the majority decides on the samples obtained (never fail the
            // library on a flaky call).
            details.push(`${e.id}: one resample unavailable (call failed twice)`);
          }
        }
      }
      if (fails < 2) {
        details.push(`${e.id}: OK${fails ? " (1 of 3 samples dissented)" : ""}`);
      } else {
        failures.push(
          `${e.id}: failed majority-of-3 — band_true=${verdict.band_true} register_specific=${verdict.register_specific} — ${verdict.reasoning}`,
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
