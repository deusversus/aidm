import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmSpanHandle } from "@/lib/tools";

/**
 * Shared agent-call context. Every agent's `execute` takes its input plus a
 * small deps bag so tests can inject mocks and the turn pipeline can thread
 * tracing + logging through without making every agent import provider
 * singletons directly.
 *
 * `modelContext` carries the per-campaign `{ provider, tier_models }` config
 * (from Commit A's provider registry). The turn workflow (Commit D) reads it
 * once from `campaign.settings` and threads it through every agent call on
 * that turn. When absent, callers fall back to `anthropicFallbackConfig()`
 * — for scripts, `/api/ready`, and tests that don't care about per-campaign
 * routing.
 */
export interface AgentDeps {
  /** Optional Langfuse span handle. Null-safe inside each agent. */
  trace?: AidmSpanHandle;
  /** Optional structured logger. Defaults to console. */
  logger?: AgentLogger;
  /** Per-campaign provider + tier_models. Propagates into every LLM call. */
  modelContext?: CampaignProviderConfig;
  /**
   * Per-turn prompt-fingerprint recorder. Every agent that resolves a
   * prompt via the registry calls this with its agent name + the
   * composed prompt's SHA-256 fingerprint. The turn workflow
   * aggregates into a map and persists to `turns.prompt_fingerprints`
   * so voice regressions caused by prompt edits are traceable to the
   * exact commit that changed any prompt file. Null-safe — callers
   * without a recorder just don't get the audit trail.
   */
  recordPrompt?: (agentName: string, fingerprint: string) => void;
  /**
   * Per-turn cost recorder (Commit 9). Parallel to `recordPrompt`.
   * `_runner.ts` computes USD cost per agent call from the provider
   * response's usage + the canonical pricing table (`@/lib/llm/pricing`)
   * and calls this with `(agentName, costUsd)`. The turn workflow
   * accumulates across all pre-pass + KA + consultant calls and writes
   * the total to `turns.costUsd`; the post-turn flow also increments
   * `user_cost_ledger[user, today]` by the same delta. Null-safe —
   * tests + scripts without a recorder skip the accounting silently.
   *
   * KA + Chronicler bypass this path: the Agent SDK returns its own
   * `total_cost_usd` on the result event, which the agent wrappers
   * surface directly to the turn workflow without going through
   * `recordCost` (they're ALREADY aggregated by the SDK). `recordCost`
   * is strictly for `_runner.ts`-based consultants where we have to
   * compute the cost ourselves.
   */
  recordCost?: (agentName: string, costUsd: number) => void;
}

export type AgentLogLevel = "info" | "warn" | "error";

export type AgentLogger = (
  level: AgentLogLevel,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export const defaultLogger: AgentLogger = (level, message, meta) => {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

// No throwable fallback class by design: agents return fallback values and
// log. If a caller ever needs to differentiate "fallback due to infra
// failure" from "fallback because that was the correct answer," wire an
// explicit `onFallback` callback on `AgentDeps` at that time. Until then,
// an unused class is speculative abstraction.
