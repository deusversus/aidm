import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { authorshipDetection } from "./suites/authorship-detection";
import { budgetAssertions } from "./suites/budget-assertions";
import { goldenProfile } from "./suites/golden-profile";
import { notAnotherAnime } from "./suites/not-another-anime";
import { rendererEfficacy } from "./suites/renderer-efficacy";
import { scaffolds } from "./suites/scaffolds";
import type { Suite, SuiteResult } from "./types";

/**
 * The eval harness (blueprint §10). `pnpm evals` runs everything;
 * `pnpm evals:ci` (--ci) runs the deterministic gate only — no LLM calls,
 * no API keys. Evals prove regressions, not product quality; long-horizon
 * play remains the final judge.
 */

const ci = process.argv.includes("--ci");
// Positional args select suites by name (spend-surgical LLM runs: §0.9 —
// `pnpm evals not-another-anime` judges the library without buying every
// other paid suite). No args = all suites, as before.
const requested = [...new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")))];
const allSuites: Suite[] = [
  budgetAssertions,
  goldenProfile,
  notAnotherAnime,
  rendererEfficacy,
  authorshipDetection,
  ...scaffolds,
];
const suites =
  requested.length > 0 ? allSuites.filter((s) => requested.includes(s.name)) : allSuites;
if (requested.length > 0 && suites.length !== requested.length) {
  const known = new Set(allSuites.map((s) => s.name));
  throw new Error(`unknown suite(s): ${requested.filter((r) => !known.has(r)).join(", ")}`);
}

const results: SuiteResult[] = [];
for (const suite of suites) {
  if (ci && suite.requiresLlm) {
    results.push({
      name: suite.name,
      gate: suite.gate,
      status: "skipped",
      details: ["skipped under --ci (LLM suite)"],
      failures: [],
    });
    continue;
  }
  try {
    results.push(await suite.run());
  } catch (err) {
    results.push({
      name: suite.name,
      gate: suite.gate,
      status: "fail",
      details: [],
      failures: [err instanceof Error ? err.message : String(err)],
    });
  }
}

for (const r of results) {
  const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "⊘";
  console.log(`${mark} ${r.name} [${r.status}] — gate: ${r.gate}`);
  for (const f of r.failures) console.log(`    FAIL: ${f}`);
  if (r.status === "pass" && r.details.length > 0 && r.details.length <= 6) {
    for (const d of r.details) console.log(`    ${d}`);
  }
}

const outPath = join(process.cwd(), "evals", "latest.json");
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), ci, results }, null, 2));
console.log(`\nwrote ${outPath}`);

// --ci makes no LLM calls, and flushing would touch the env Proxy (full
// parse) in environments that only carry DATABASE_URL or nothing at all.
if (!ci) {
  await flushLangfuse();
}
if (results.some((r) => r.status === "fail")) {
  process.exitCode = 1;
}
