/**
 * Client-side env surface.
 *
 * `src/lib/env.ts` parses `process.env` via a Zod Proxy on first access.
 * That works server-side (route handlers, Server Components) where every
 * variable is readable at request time. It does NOT work client-side —
 * browsers only have the `NEXT_PUBLIC_*` subset, and only because Next.js
 * inlines those at build time via string substitution.
 *
 * This module exposes the client-safe subset as a plain object. Under the
 * hood it reads `process.env.NEXT_PUBLIC_*` directly — Next replaces those
 * reads with literals during `next build`, so the browser ships concrete
 * values rather than a runtime lookup.
 *
 * Use `clientEnv` in anything rendered to the browser; use `env` (from
 * `./env`) everywhere else. Never add non-`NEXT_PUBLIC_*` keys here — they
 * silently resolve to `undefined` in client bundles.
 */

export const clientEnv = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL ?? "/sign-up",
  NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL:
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL ?? "/campaigns",
  NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL:
    process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL ?? "/campaigns",
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
} as const;
