/** Eval harness contracts (blueprint §10). */

export interface SuiteResult {
  name: string;
  status: "pass" | "fail" | "skipped";
  /** Which milestone gates this suite (skipped suites say why). */
  gate: string;
  details: string[];
  failures: string[];
}

export interface Suite {
  name: string;
  /** Milestone at which this suite must run and pass. */
  gate: string;
  /** LLM-calling suites are skipped under --ci (deterministic gate only). */
  requiresLlm: boolean;
  run(): Promise<SuiteResult>;
}

export function skipped(suite: Suite, reason: string): SuiteResult {
  return { name: suite.name, status: "skipped", gate: suite.gate, details: [reason], failures: [] };
}
