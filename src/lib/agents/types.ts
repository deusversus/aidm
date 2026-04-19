import type { AidmSpanHandle } from "@/lib/tools";

/**
 * Shared agent-call context. Every agent's `execute` takes its input plus a
 * small deps bag so tests can inject mocks and the turn pipeline can thread
 * tracing + logging through without making every agent import provider
 * singletons directly.
 *
 * Why not AgentSDK's context: these agents run as Mastra steps, not inside
 * KA's Agent SDK session. KA (M1 Commit 6) will invoke them either via the
 * Agent SDK's subagent primitive or via direct step calls — both paths
 * route through the same `execute` functions.
 */
export interface AgentDeps {
  /** Optional Langfuse span handle. Null-safe inside each agent. */
  trace?: AidmSpanHandle;
  /** Optional structured logger. Defaults to console. */
  logger?: AgentLogger;
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
