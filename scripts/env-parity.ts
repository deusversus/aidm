import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ENV_KEYS, ENV_KEYS_WITH_DEFAULTS } from "@/lib/env";

/**
 * C10 env-parity check (M2 plan): diff the deployed Railway variable NAMES
 * against the env schema's expected set, and the NEXT_PUBLIC_* keys against
 * the Dockerfile builder-stage ARG list (the silent-no-op class — a
 * NEXT_PUBLIC_* var without its ARG inlines `undefined` into the client
 * bundle). Names only, NEVER values: the Railway JSON is parsed for keys
 * and discarded. The VOYAGE_API_KEY incident (2026-07-11) dies here.
 *
 * Usage: pnpm env:parity   (requires the Railway CLI linked to the aidm
 * production service; CI wiring needs a RAILWAY_TOKEN secret — not set up.)
 * Exit 1 on any missing name.
 */

function railwayVariableNames(): string[] {
  const raw = execFileSync("railway", ["variables", "--json"], { encoding: "utf8" });
  return Object.keys(JSON.parse(raw) as Record<string, unknown>);
}

function dockerfileArgs(): string[] {
  // BUILDER-stage ARGs only (audit): NEXT_PUBLIC_* inlining happens in the
  // build stage; an ARG in another stage satisfies nothing.
  const text = readFileSync("Dockerfile", "utf8");
  const stages = text.split(/^FROM\s.*$/m);
  const builderIdx = [...text.matchAll(/^FROM\s.*$/gm)].findIndex((m) =>
    /\sAS\s+builder/i.test(m[0]),
  );
  const scope = builderIdx >= 0 ? (stages[builderIdx + 1] ?? "") : text;
  return [...scope.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1] ?? "").filter(Boolean);
}

/** Opt-in feature keys: absent everywhere = the feature is off, not a
 *  parity failure. Reported as info so the gap stays visible. */
const FEATURE_KEYS = new Set(["ELEVENLABS_API_KEY"]);

function main(): void {
  const deployed = new Set(railwayVariableNames());
  const defaults = new Set(ENV_KEYS_WITH_DEFAULTS);
  const failures: string[] = [];

  const featureOff = ENV_KEYS.filter((k) => FEATURE_KEYS.has(k) && !deployed.has(k));
  if (featureOff.length > 0) {
    console.log(`(info) feature keys not deployed (feature off): ${featureOff.join(", ")}`);
  }

  // Schema keys the deploy is missing (defaults excluded — absent is fine).
  const missing = ENV_KEYS.filter(
    (k) => !deployed.has(k) && !defaults.has(k) && !FEATURE_KEYS.has(k) && k !== "NODE_ENV",
  );
  if (missing.length > 0) {
    failures.push(`Railway is missing schema keys: ${missing.join(", ")}`);
  }

  // Every NEXT_PUBLIC_* schema key needs a builder-stage ARG or the browser
  // bundle inlines undefined (Dockerfile gotcha, CLAUDE.md).
  const args = new Set(dockerfileArgs());
  const missingArgs = ENV_KEYS.filter((k) => k.startsWith("NEXT_PUBLIC_") && !args.has(k));
  if (missingArgs.length > 0) {
    failures.push(`Dockerfile builder stage is missing ARGs: ${missingArgs.join(", ")}`);
  }

  // Informational only: deployed names outside the schema (never an error —
  // Railway-injected vars live here).
  const extras = [...deployed].filter(
    (k) => !ENV_KEYS.includes(k as (typeof ENV_KEYS)[number]) && !k.startsWith("RAILWAY_"),
  );
  if (extras.length > 0) {
    console.log(`(info) deployed names outside the schema: ${extras.join(", ")}`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`ENV PARITY: ${f}`);
    process.exit(1);
  }
  console.log(
    `env parity OK — ${ENV_KEYS.length} schema keys checked against ${deployed.size} deployed names + Dockerfile ARGs (names only; no values read into the report)`,
  );
}

main();
