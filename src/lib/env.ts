import { z } from "zod";

// Minimal env schema for M0. Auth (Clerk), observability (Langfuse/PostHog), and
// provider keys (Anthropic/OpenAI/Google) land in their respective M0+ commits.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
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
export const tiers = {
  fast: { provider: "google", model: "gemini-3.1-flash" },
  thinking: { provider: "anthropic", model: "claude-opus-4-7" },
  creative: { provider: "anthropic", model: "claude-opus-4-7" },
} as const satisfies Record<string, { provider: string; model: string }>;

export type Tier = keyof typeof tiers;
