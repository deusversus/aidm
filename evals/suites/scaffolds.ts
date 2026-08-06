import type { Suite, SuiteResult } from "../types";
import { controlKey } from "./control-key";
import { fingerprintReliability } from "./fingerprint-reliability";
import { MIN_SOAK_TURNS, flywheelProspective } from "./flywheel-prospective";

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
  scaffold(
    "seed-integrity",
    "M3",
    `§10.5 payoff windows + organic-detection recall need the seed engine in anger. NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns (§10.3's letter; the M2 gate ran 24 — docs/retros/M2-drift-soak.md): run \`pnpm soak -- --turns=${MIN_SOAK_TURNS}\` or deeper, then re-run with FLYWHEEL_CAMPAIGN_ID=<campaign uuid>. Until then nothing is measured — this is NOT a pass`,
  ),
  scaffold(
    "golden-regression",
    "M1",
    "§10.7 golden turns need the turn loop (M1). Carried fixtures at evals/golden/; the v4-era mockllm_fixture_dir field in gameplay fixtures gets remapped or dropped when this suite lands",
  ),
];
