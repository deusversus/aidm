import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { authorshipDetection } from "./suites/authorship-detection";
import { budgetAssertions } from "./suites/budget-assertions";
import { channelRouting } from "./suites/channel-routing";
import { goldenProfile } from "./suites/golden-profile";
import { notAnotherAnime } from "./suites/not-another-anime";
import { rendererEfficacy } from "./suites/renderer-efficacy";
import { sakkanNeutrality } from "./suites/sakkan-neutrality";
import { scaffolds } from "./suites/scaffolds";
import { schemaGrammar } from "./suites/schema-grammar";
import { thinIpDrill } from "./suites/thin-ip-drill";
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
  sakkanNeutrality,
  authorshipDetection,
  channelRouting,
  schemaGrammar,
  thinIpDrill,
  ...scaffolds,
];
const suites =
  requested.length > 0 ? allSuites.filter((s) => requested.includes(s.name)) : allSuites;
if (requested.length > 0 && suites.length !== requested.length) {
  const known = new Set(allSuites.map((s) => s.name));
  throw new Error(`unknown suite(s): ${requested.filter((r) => !known.has(r)).join(", ")}`);
}

const results: SuiteResult[] = [];
/**
 * Suites the CI gate never runs BY DESIGN (they buy model calls). They report
 * `skipped` like everything else, but they are a different fact from a gate
 * suite that RAN and found no evidence — and conflating the two is what made
 * the roll-up print "11 of 13 measured nothing" on a healthy run, which trains
 * exactly the ignoring the roll-up exists to prevent.
 */
const ciExcluded = new Set<string>();
for (const suite of suites) {
  if (ci && suite.requiresLlm) {
    ciExcluded.add(suite.name);
    results.push({
      name: suite.name,
      gate: suite.gate,
      status: "skipped",
      details: ["excluded under --ci (requiresLlm — the deterministic gate buys no model calls)"],
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
  // A skipped suite ALWAYS prints its reason. A silent ⊘ is indistinguishable
  // from a pass at a glance, and a gate suite that quietly measures nothing is
  // how a milestone gets called green on evidence nobody produced.
  if (r.status === "skipped") {
    const why = ciExcluded.has(r.name) ? "EXCLUDED" : "SKIPPED";
    for (const d of r.details) console.log(`    ${why}: ${d}`);
  }
  if (r.status === "pass" && r.details.length > 0 && r.details.length <= 6) {
    for (const d of r.details) console.log(`    ${d}`);
  }
}

const excluded = results.filter((r) => ciExcluded.has(r.name));
if (excluded.length > 0) {
  console.log(
    `\n${excluded.length} suite(s) EXCLUDED under --ci (requiresLlm — not a measurement gap): ${excluded
      .map((r) => r.name)
      .join(", ")}`,
  );
}
// The roll-up that matters: a GATE suite that ran and produced no evidence.
// Only these — an --ci exclusion is a policy, not a hole, and mixing them in
// buried the real signal under ten lines of noise.
const measuredNothing = results.filter((r) => r.status === "skipped" && !ciExcluded.has(r.name));
if (measuredNothing.length > 0) {
  console.log(
    `\n${measuredNothing.length} gate suite(s) MEASURED NOTHING (ran, no evidence — NOT a pass): ${measuredNothing
      .map((r) => `${r.name} [gate ${r.gate}]`)
      .join(", ")}`,
  );
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
