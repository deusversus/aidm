import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url(),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),

  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default("https://cloud.langfuse.com"),

  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

// Lazy validation. Parsing at module import breaks Next.js production builds,
// which import route handlers during page-data collection without runtime env
// set. Instead, validate on first property access — which only happens at
// request time for dynamic routes, long after the build phase.
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

export const tiers = {
  fast: { provider: "google", model: "gemini-3.1-flash" },
  thinking: { provider: "anthropic", model: "claude-opus-4-7" },
  creative: { provider: "anthropic", model: "claude-opus-4-7" },
} as const satisfies Record<string, { provider: string; model: string }>;

export type Tier = keyof typeof tiers;
