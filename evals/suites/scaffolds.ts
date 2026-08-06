import type { Suite, SuiteResult } from "../types";
import { controlKey } from "./control-key";
import { fingerprintReliability } from "./fingerprint-reliability";
import { flywheelProspective } from "./flywheel-prospective";
import { seedIntegrity } from "./seed-integrity";

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
  // §7.5 — LIVE at C8: the control key honored in play (the integrator meters it).
  controlKey,
  scaffold(
    "drift-soak",
    "M2",
    "§10.3 needs scripted 50–100 turn runs (M2); drift band held, corrections restore within one Sakkan interval",
  ),
  scaffold(
    "flywheel-round-trip",
    "M1",
    "§6.8 the M1 gate is IMPLEMENTED as a vitest integration suite, not an eval-harness suite: src/lib/turn/__tests__/flywheel.integration.test.ts drives the real turn loop (real Postgres, scripted model calls) with one named test per layer — nine layers + the §6.9 player profile — each proving writer→reader by surfacing planted content through the layer's reader. This scaffold stays skipped and points there",
  ),
  // §6.8 — LIVE at M3 C5: prospective surfacing, adjudicated over a soaked
  // campaign's rows. It skips (never fails) with its own reason until one
  // exists — the suite states the depth it needs rather than grading a run
  // that cannot carry the claim.
  flywheelProspective,
  // §10.5 — LIVE at M3R4 B1: payoff windows, dependency orphans and the
  // organic/declared recall spot-check, graded over the same soaked campaign.
  // It was a `scaffold(...)` stub until now, and the stub LIED by implication:
  // its skip text told the reader to re-run with a campaign id once a soak
  // existed, as if the grading machinery were waiting behind that flag. It was
  // never written (M3 close, 60c799b, recorded it UNBUILT). Now it is.
  seedIntegrity,
  scaffold(
    "golden-regression",
    "M1",
    "§10.7 golden turns need the turn loop (M1). Carried fixtures at evals/golden/; the v4-era mockllm_fixture_dir field in gameplay fixtures gets remapped or dropped when this suite lands",
  ),
];
