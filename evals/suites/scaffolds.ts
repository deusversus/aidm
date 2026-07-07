import type { Suite, SuiteResult } from "../types";

/**
 * §10 suites that gate later milestones — scaffolded now (axiom 8: the
 * whole shape), each skipping with its reason until its machinery lands.
 */

function scaffold(name: string, gate: string, reason: string): Suite {
  return {
    name,
    gate,
    requiresLlm: false,
    async run(): Promise<SuiteResult> {
      return { name, gate, status: "skipped", details: [reason], failures: [] };
    },
  };
}

export const scaffolds: Suite[] = [
  scaffold(
    "fingerprint-reliability",
    "M2",
    "§10.1 test-retest anchor scoring needs the Sakkan (M2); demotes unreliable axes",
  ),
  scaffold(
    "drift-soak",
    "M2",
    "§10.3 needs scripted 50–100 turn runs (M2); drift band held, corrections restore within one Sakkan interval",
  ),
  scaffold(
    "flywheel-round-trip",
    "M1",
    "§6.8 needs all nine layers live with writers+readers (M1); planted content must surface via each layer's reader",
  ),
  scaffold(
    "flywheel-prospective",
    "M3",
    "§6.8 N+40 prospective surfacing via Director/seed machinery (M3)",
  ),
  scaffold(
    "seed-integrity",
    "M3",
    "§10.5 payoff windows + organic-detection recall need the seed engine in anger (M3)",
  ),
  scaffold(
    "golden-regression",
    "M1",
    "§10.7 golden turns need the turn loop (M1). Carried fixtures at evals/golden/; the v4-era mockllm_fixture_dir field in gameplay fixtures gets remapped or dropped when this suite lands",
  ),
];
