import { stripDirectiveFences } from "@/lib/client/plain-prose";
import type { Suite, SuiteResult } from "../types";

/**
 * §4.5 blind-protocol corollary, M3-DG: the Gauge reads STORY, not chrome. A
 * scene wearing a display device (a ` ```readout ` window, a ` ```memory `
 * flashback) must score exactly as it would as bare prose — otherwise the
 * chrome silently moves the drift measurement and the whole feedback loop
 * distrusts itself.
 *
 * This is SCRIPTED, never live (deterministic — runs under `evals:ci`): it
 * asserts that the projection the Sakkan reads (`stripDirectiveFences`, the
 * same projection pins and compaction use) turns directive-fenced narration
 * into scorer input IDENTICAL to the same scene written as plain prose. It also
 * pins that the projection is load-bearing — the RAW inputs differ, only the
 * projected ones match — so a future refactor that drops the strip fails here
 * instead of silently biasing the Gauge.
 *
 * WIRING NOTE (integrator): the Sakkan's sample builder (src/lib/sakkan/
 * sakkan.ts, `proses.map((r) => r.narration)`) must map each narration through
 * `stripDirectiveFences` for this guarantee to hold at RUNTIME. That one-line
 * change lives in the concurrently-edited Sakkan file and is called out in the
 * M3-DG report rather than applied here.
 */

/** The Sakkan joins its sample turns with this separator (sakkan.ts) — chrome-
 *  free and identical on both arms, so it never affects the neutrality result. */
const SCENE_BREAK = "\n\n--- scene break ---\n\n";

/** Build the Sakkan's scorer input from raw narrations, oldest→newest. */
function scorerInput(narrations: string[], project: (s: string) => string): string {
  return narrations.map(project).join(SCENE_BREAK);
}

export const sakkanNeutrality: Suite = {
  name: "sakkan-neutrality",
  gate: "M3 (§4.5 / M3-DG)",
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    // Two-turn sample: one turn wears a readout window, one wears a memory
    // flashback. The PLAIN arm is the identical scene written as bare prose.
    const fenced = [
      "The terminal woke.\n\n```readout\nBOUNTY: Vicious — 6,000,000 woolongs\nSTATUS: active\n```\n\nJet whistled low.",
      "She closed her eyes.\n\n```memory\nThe pier, years ago. Rain. A red umbrella she never opened.\n```\n\nThen the present came back.",
    ];
    const plain = [
      "The terminal woke.\n\nBOUNTY: Vicious — 6,000,000 woolongs\nSTATUS: active\n\nJet whistled low.",
      "She closed her eyes.\n\nThe pier, years ago. Rain. A red umbrella she never opened.\n\nThen the present came back.",
    ];

    const projectedFenced = scorerInput(fenced, stripDirectiveFences);
    const projectedPlain = scorerInput(plain, stripDirectiveFences);
    const rawFenced = scorerInput(fenced, (s) => s);

    // The guarantee: chrome-bearing prose and its stripped projection are the
    // SAME scorer input.
    if (projectedFenced === projectedPlain) {
      details.push("neutral: projected scorer input for fenced prose == plain prose");
    } else {
      failures.push(
        "directive-fenced narration did NOT project to the same scorer input as plain prose — the Gauge would read chrome",
      );
    }

    // The projection is load-bearing: without it the inputs differ (the fence
    // markers reach the scorer), so a dropped strip is a real regression.
    if (rawFenced !== projectedPlain) {
      details.push("load-bearing: without the projection the fenced input differs (strip matters)");
    } else {
      failures.push(
        "raw fenced input already equals plain — the projection is a no-op; the neutrality assertion proves nothing",
      );
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
