import { z } from "zod";

// Env schema grows commit-by-commit. Each integration adds its own fields.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // --- Clerk auth (commit 3) ---
  // Publishable key inlined into client bundle at build time. Must be set in
  // Railway's BUILD env, not just runtime, or Clerk throws in the browser.
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().default("/sign-in"),
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().default("/sign-up"),
  NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: z.string().default("/campaigns"),
  NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: z.string().default("/campaigns"),

  // --- LLM providers (commit 4) ---
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // --- Observability (commit 5) ---
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default("https://us.cloud.langfuse.com"),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
});

export type Env = z.infer<typeof envSchema>;

// Lazy validation. Parsing at module import breaks Next.js production builds,
// which import route handlers during page-data collection without runtime env
// set. Instead, validate on first property access — which only happens at
// request time for dynamic routes, long after the build phase.
//
// Note: spread/JSON.stringify/Object.keys on `env` will force a full parse
// via ownKeys. Current codebase has no such callers; if one lands, either
// avoid the spread or expose an explicit load() function.
let cached: Env | undefined;

export const env = new Proxy({} as Env, {
  get(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return cached[prop as keyof Env];
  },
  has(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return prop in cached;
  },
  ownKeys() {
    cached ??= envSchema.parse(process.env);
    return Reflect.ownKeys(cached);
  },
  getOwnPropertyDescriptor(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return Reflect.getOwnPropertyDescriptor(cached, prop);
  },
});

// Model tiers — current 2026 defaults, user-confirmed.
//
// `fast` is the production fast-tier (IntentClassifier, rerankers, research
// subagents). `probe` is a separate cheapest-possible tier used only for
// reachability checks (`/api/ready`); it defaults to Haiku so the probe stays
// inside Anthropic's infra and doesn't conflate "LLM availability" with
// "Google availability". Agents don't route through `probe`.
export const tiers = {
  probe: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  fast: { provider: "google", model: "gemini-3.1-flash" },
  thinking: { provider: "anthropic", model: "claude-opus-4-7" },
  creative: { provider: "anthropic", model: "claude-opus-4-7" },
} as const satisfies Record<string, { provider: string; model: string }>;

export type Tier = keyof typeof tiers;
