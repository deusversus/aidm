/**
 * Token approximation for block budgets: chars/4, the standard English
 * heuristic. M0 budgets (window ceiling, pin cap, B2 ceiling) are coarse
 * gates, not billing — billing reads real usage from the API response.
 * If telemetry shows the approximation drifting badly, swap in a real
 * tokenizer here; every budget check routes through this one function.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
