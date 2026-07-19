import { z } from "zod";

// Env schema grows commit-by-commit. Each integration adds its own fields.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // --- Clerk auth ---
  // Publishable key inlined into client bundle at build time. Must be set in
  // Railway's BUILD env, not just runtime, or Clerk throws in the browser.
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().default("/sign-in"),
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().default("/sign-up"),
  NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: z.string().default("/campaigns"),
  NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: z.string().default("/campaigns"),

  // --- LLM ---
  // Anthropic-only for story generation (blueprint §3). Voyage is the named
  // embedding exception — Anthropic has no embeddings API.
  ANTHROPIC_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),

  // --- Voice (the media multi-provider exception, §9.5 — TTS side project) ---
  // Absent key = the listen button never renders; no fallback, no error.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default("JBFqnCBsd6RMkjVDRZzb"),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),

  // --- Observability ---
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default("https://us.cloud.langfuse.com"),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
});

export type Env = z.infer<typeof envSchema>;

/** Schema key names (no parse, build-safe) — the env-parity check's expected set. */
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

/** Keys with schema defaults — absent on the deploy target is fine for these. */
export const ENV_KEYS_WITH_DEFAULTS = Object.entries(envSchema.shape)
  .filter(([, s]) => s instanceof z.ZodDefault)
  .map(([k]) => k);

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
    const value = cached[prop as keyof Env];
    // Self-heal a stale snapshot: the parse-once cache would otherwise report
    // a key missing for the process's whole lifetime even if process.env
    // gains it later (each bundled module instance carries its own `cached`,
    // so one early parse against a partial env would poison every later read).
    // If the cache says undefined but live process.env disagrees, re-parse.
    if (value === undefined && typeof prop === "string" && process.env[prop] !== undefined) {
      cached = envSchema.parse(process.env);
      return cached[prop as keyof Env];
    }
    return value;
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
