import type {
  DeterministicChecks,
  EvalResult,
  EvalSummary,
  ExpectedOutcomeBounds,
  GoldenFixture,
} from "./types";

/**
 * Deterministic checks + aggregation helpers (Commit 8).
 *
 * Runs on every CI run. Zero LLM calls. Fast.
 */

interface CapturedTurn {
  intent: {
    intent: string;
    action?: string;
    epicness: number;
    special_conditions: string[];
  };
  outcome: {
    /** v4 categorical: MINOR | SIGNIFICANT | CLIMACTIC */
    narrative_weight: string;
    /** critical_failure | failure | partial_success | success | critical_success */
    success_level: string;
    rationale: string;
  } | null;
  narrative: string;
}

export function runDeterministicChecks(
  fixture: GoldenFixture,
  captured: CapturedTurn,
): DeterministicChecks {
  const intentExact = captured.intent.intent === fixture.expected_intent.intent;
  const epicnessActual = captured.intent.epicness;
  const epicnessInRange =
    (fixture.expected_intent.epicness_min === undefined ||
      epicnessActual >= fixture.expected_intent.epicness_min) &&
    (fixture.expected_intent.epicness_max === undefined ||
      epicnessActual <= fixture.expected_intent.epicness_max);

  const outcomeCheck = checkOutcomeBounds(fixture.expected_outcome_bounds, captured.outcome);

  const narrativeLower = captured.narrative.toLowerCase();
  const missing = fixture.expected_narrative_deterministic.must_include_entity.filter(
    (entity) => !narrativeLower.includes(entity.toLowerCase()),
  );
  const forbiddenHit = fixture.expected_narrative_deterministic.must_not_include.filter((phrase) =>
    narrativeLower.includes(phrase.toLowerCase()),
  );
  const narrativeLength = captured.narrative.length;
  const narrativeLengthOk =
    narrativeLength >= fixture.expected_narrative_deterministic.min_length_chars &&
    narrativeLength <= fixture.expected_narrative_deterministic.max_length_chars;

  return {
    intentExact,
    intentActual: captured.intent.intent,
    epicnessActual,
    epicnessInRange,
    outcomeInBounds: outcomeCheck,
    outcomeNarrativeWeight: captured.outcome?.narrative_weight ?? null,
    outcomeSuccessLevel: captured.outcome?.success_level ?? null,
    narrativeMustIncludeMissing: missing,
    narrativeMustNotIncludeHit: forbiddenHit,
    narrativeLengthOk,
    narrativeLength,
  };
}

function checkOutcomeBounds(
  bounds: ExpectedOutcomeBounds | undefined,
  outcome: CapturedTurn["outcome"],
): boolean {
  // Bounds absent → no expectation. Auto-pass.
  if (!bounds) return true;
  // Outcome absent → the turn didn't pre-judge. That's fine unless
  // the fixture actually expected an outcome shape.
  if (!outcome) {
    const anyBoundSet =
      (bounds.narrative_weight_one_of?.length ?? 0) > 0 ||
      (bounds.success_level_one_of?.length ?? 0) > 0 ||
      bounds.rationale_non_empty === true;
    return !anyBoundSet;
  }
  if (
    bounds.narrative_weight_one_of &&
    bounds.narrative_weight_one_of.length > 0 &&
    !bounds.narrative_weight_one_of.includes(
      outcome.narrative_weight as "MINOR" | "SIGNIFICANT" | "CLIMACTIC",
    )
  ) {
    return false;
  }
  if (
    bounds.success_level_one_of &&
    bounds.success_level_one_of.length > 0 &&
    !bounds.success_level_one_of.includes(
      outcome.success_level as
        | "critical_failure"
        | "failure"
        | "partial_success"
        | "success"
        | "critical_success",
    )
  ) {
    return false;
  }
  if (bounds.rationale_non_empty === true && outcome.rationale.trim().length === 0) {
    return false;
  }
  return true;
}

export function evalResultPassed(d: DeterministicChecks): boolean {
  return (
    d.intentExact &&
    d.epicnessInRange &&
    d.outcomeInBounds &&
    d.narrativeMustIncludeMissing.length === 0 &&
    d.narrativeMustNotIncludeHit.length === 0 &&
    d.narrativeLengthOk
  );
}

export function summarize(
  mode: "ci" | "local" | "judge",
  results: EvalResult[],
  commit?: string,
): EvalSummary {
  return {
    ranAt: new Date().toISOString(),
    commit,
    mode,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    scenarios: results,
  };
}

/** Compact one-line summary per scenario for stdout / PR comment. */
export function formatResultLine(r: EvalResult): string {
  const status = r.passed ? "PASS" : "FAIL";
  const d = r.deterministic;
  const parts: string[] = [`[${status}]`, r.id];
  if (!d.intentExact) parts.push(`intent:${d.intentActual}`);
  if (!d.epicnessInRange) parts.push(`epicness:${d.epicnessActual?.toFixed(2)}`);
  if (!d.outcomeInBounds) parts.push("outcome:OOB");
  if (d.narrativeMustIncludeMissing.length > 0) {
    parts.push(`missing:${d.narrativeMustIncludeMissing.join(",")}`);
  }
  if (d.narrativeMustNotIncludeHit.length > 0) {
    parts.push(`forbidden:${d.narrativeMustNotIncludeHit.join(",")}`);
  }
  if (!d.narrativeLengthOk) parts.push(`length:${d.narrativeLength}`);
  if (r.error) parts.push(`ERROR:${r.error}`);
  return parts.join(" ");
}
