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
