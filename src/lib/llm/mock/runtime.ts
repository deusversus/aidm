import { join } from "node:path";
import { type query, query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import { createMockQuery } from "./agent-sdk";
import { type FixtureRegistry, emptyRegistry, loadFixtures } from "./fixtures";

/**
 * Process-level mock LLM runtime state (Phase D of docs/plans/mockllm.md).
 *
 * Loads the fixture registry once from `MOCKLLM_FIXTURES_DIR` (or the
 * default `evals/fixtures/llm/`) on first demand, caches it, and
 * offers `getQueryFn()` — a helper that hands back the real
 * `@anthropic-ai/claude-agent-sdk` query function when AIDM_MOCK_LLM
 * is off, or a fixture-backed `mockQuery` when it's on.
 *
 * Call sites (`key-animator.ts`, `chronicler.ts`) change ONE line
 * each: `const queryFn = deps.queryFn ?? getQueryFn();`. Tests that
 * pass an explicit `queryFn` bypass both paths — nothing changes for
 * existing test coverage.
 *
 * `resetMockRuntimeForTesting()` clears the cached registry so suites
 * that swap MOCKLLM_FIXTURES_DIR between tests pick up fresh content.
 */

let _cachedRegistry: FixtureRegistry | null = null;
let _cachedQueryFn: typeof query | null = null;

function defaultFixturesDir(): string {
  return process.env.MOCKLLM_FIXTURES_DIR ?? join(process.cwd(), "evals", "fixtures", "llm");
}

/**
 * Get the currently-loaded fixture registry, lazy-loading from
 * MOCKLLM_FIXTURES_DIR on first access. Missing directories produce an
 * empty registry (synth fallback handles the miss path).
 */
export function getRuntimeRegistry(): FixtureRegistry {
  if (_cachedRegistry) return _cachedRegistry;
  try {
    _cachedRegistry = loadFixtures(defaultFixturesDir());
  } catch (err) {
    // A malformed fixture shouldn't silently degrade to "no mock" —
    // if the operator turned on AIDM_MOCK_LLM, they want fixtures.
    // But we also shouldn't crash apps that don't use the mock.
    // Log once, fall back to empty so calls synth.
    console.warn(
      `[mockllm] failed to load fixtures from ${defaultFixturesDir()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    _cachedRegistry = emptyRegistry();
  }
  return _cachedRegistry;
}

/**
 * Return the `query` function to use for a call. When AIDM_MOCK_LLM=1,
 * returns a fixture-backed `mockQuery`; otherwise returns the real
 * Claude Agent SDK `query`. The real import is done dynamically so
 * callers can use this in build contexts where the SDK module isn't
 * wanted. The cached return value means repeated calls don't
 * re-initialize on the hot path.
 */
export function getQueryFn(): typeof query {
  if (_cachedQueryFn) return _cachedQueryFn;
  if (process.env.AIDM_MOCK_LLM === "1") {
    _cachedQueryFn = createMockQuery(getRuntimeRegistry());
    return _cachedQueryFn;
  }
  _cachedQueryFn = realQuery;
  return _cachedQueryFn;
}

/** Test-only — clears cached registry + queryFn so env changes propagate. */
export function resetMockRuntimeForTesting(): void {
  _cachedRegistry = null;
  _cachedQueryFn = null;
}
