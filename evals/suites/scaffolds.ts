import type { Suite, SuiteResult } from "../types";
import { fingerprintReliability } from "./fingerprint-reliability";

/**
 * §10 suites that gate later milestones — scaffolded now (axiom 8: the
 * whole shape), each skipping with its reason until its machinery lands.
 * As each lands it graduates from a `scaffold(...)` stub to its real suite,
 * imported here — run.ts spreads `...scaffolds`, so no registration edit is
 * needed when one goes live (fingerprint-reliability, C7, is the first).
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
  // §10.1 — LIVE at C7: the Gauge-v2 reliability meter (the integrator runs it).
  fingerprintReliability,
  scaffold(
    "drift-soak",
    "M2",
    "§10.3 needs scripted 50–100 turn runs (M2); drift band held, corrections restore within one Sakkan interval",
  ),
  scaffold(
    "flywheel-round-trip",
    "M1",
    "§6.8 the M1 gate is IMPLEMENTED as a vitest integration suite, not an eval-harness suite: src/lib/turn/__tests__/flywheel.integration.test.ts drives the real turn loop (real Postgres, scripted trio) with one named test per layer — nine layers + the §6.9 player profile — each proving writer→reader by surfacing planted content through the layer's reader. This scaffold stays skipped and points there",
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
