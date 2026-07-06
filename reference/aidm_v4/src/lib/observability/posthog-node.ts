import { env } from "@/lib/env";
import { PostHog } from "posthog-node";

let _client: PostHog | undefined;

/**
 * Server-side PostHog singleton for route handlers and Server Actions.
 * Client-side page views + autocapture run via the browser SDK in the
 * PostHogProvider component — don't cross the streams.
 *
 * Returns null when PostHog isn't configured so callers can no-op silently.
 */
export function getPostHog(): PostHog | null {
  if (_client) return _client;
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  const prod = env.NODE_ENV === "production";
  _client = new PostHog(key, {
    host: env.NEXT_PUBLIC_POSTHOG_HOST,
    // Dev flushes per-event for instant feedback; prod batches over 10s or
    // 20 events (Railway is long-running; no serverless cold-start concern).
    flushAt: prod ? 20 : 1,
    flushInterval: prod ? 10_000 : 0,
  });
  return _client;
}
