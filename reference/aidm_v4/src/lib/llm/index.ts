export { getAnthropic, pingAnthropic } from "./anthropic";
export { getGoogle } from "./google";
export { getOpenAI } from "./openai";
// `tiers` + `Tier` re-exports removed in M1.5 Commit E. Runtime
// callers read per-campaign `tier_models` via modelContext; fallback
// callers import `anthropicDefaults` from @/lib/env directly, or use
// `anthropicFallbackConfig()` from @/lib/providers.
