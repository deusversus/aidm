import { env } from "@/lib/env";
import { Langfuse } from "langfuse";

let _client: Langfuse | undefined;

/**
 * Lazy singleton. Returns null when Langfuse isn't configured so callers can
 * no-op silently in dev-without-keys rather than crash. Trace helpers should
 * tolerate the null (observability is advisory, never load-bearing).
 */
export function getLangfuse(): Langfuse | null {
  if (_client) return _client;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  _client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: env.LANGFUSE_HOST,
    // Dev flushes immediately for instant feedback; prod batches so a turn
    // with ~20 spans doesn't fire 20 HTTP requests.
    flushAt: env.NODE_ENV === "production" ? 15 : 1,
  });
  return _client;
}

/**
 * Flush pending traces. Call before process exit (scripts, background jobs).
 * Route handlers don't need this — the Langfuse client flushes async on its
 * own schedule and Railway's graceful shutdown gives it ~10s before SIGKILL.
 */
export async function flushLangfuse(): Promise<void> {
  const client = getLangfuse();
  if (client) await client.flushAsync();
}
