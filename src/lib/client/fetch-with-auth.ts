declare global {
  interface Window {
    Clerk?: {
      session?: {
        getToken(options?: { skipCache?: boolean }): Promise<string | null>;
      } | null;
    };
  }
}

/**
 * A stale Clerk session token 401s an otherwise-valid request (observed after
 * a multi-hour idle tab). clerk-js keeps the cookie fresh but the in-memory
 * token can lag; forcing `getToken({ skipCache: true })` mints a live one.
 * Normal fetch; on a 401, refresh once and retry exactly once. Every non-401
 * response passes straight through — this only heals the idle-token case,
 * never masks a real auth failure or loops.
 */
export async function fetchWithAuthRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const session = window.Clerk?.session;
  if (!session?.getToken) return res;
  try {
    await session.getToken({ skipCache: true });
  } catch {
    // The refresh itself failed (offline, Clerk down) — hand back the 401 as-is
    // rather than throw; the caller's existing error path takes over.
    return res;
  }
  return fetch(input, init);
}
