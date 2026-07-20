import { z } from "zod";

/**
 * Model tiers are player-facing MENUS, not fixed assignments (blueprint §3,
 * resolved 2026-07-06). Selection is per campaign per tier, changeable at
 * any time — with the "studio handoff" warning (cache reset + possible
 * voice shift) surfaced by the UI, never silently. The engine never picks
 * for the player; DEV_TIER_SELECTION below exists only for infrastructure
 * with no campaign context (smoke scripts, pings, tests).
 */

export const TIER_MENUS = {
  narration: ["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"],
  judgment: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
  probe: ["claude-haiku-4-5", "claude-sonnet-5"],
} as const;

export type TierName = keyof typeof TIER_MENUS;

export const TierSelection = z.object({
  narration: z.enum(TIER_MENUS.narration),
  judgment: z.enum(TIER_MENUS.judgment),
  probe: z.enum(TIER_MENUS.probe),
});
export type TierSelection = z.infer<typeof TierSelection>;

/** Infrastructure-only default — cheapest sane rung of each menu. Player choice always overrides. */
export const DEV_TIER_SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

/**
 * Per-model API capabilities. Haiku 4.5 predates the 4.6-era adaptive
 * thinking and effort controls — sending either returns a 400. Fable's
 * thinking is always-on: the param is OMITTED entirely (explicit configs
 * other than adaptive are rejected) — its `adaptiveThinking: false` means
 * "don't send the param," NOT "doesn't think" (the docs class it as adaptive
 * thinking, always on). `effortControl` is the honest "does it reason?"
 * discriminator: only Haiku has neither.
 *
 * `maxOutput` is the synchronous Messages API output ceiling, used to clamp
 * the structural thinking pad (computeEffectiveMaxTokens). Values verified
 * 2026-07-20 from the models overview (platform.claude.com/docs models page).
 */
export interface ModelCaps {
  adaptiveThinking: boolean;
  effortControl: boolean;
  maxOutput: number;
}
export const MODEL_CAPS: Record<string, ModelCaps> = {
  "claude-fable-5": { adaptiveThinking: false, effortControl: true, maxOutput: 128_000 },
  "claude-opus-4-8": { adaptiveThinking: true, effortControl: true, maxOutput: 128_000 },
  "claude-sonnet-5": { adaptiveThinking: true, effortControl: true, maxOutput: 128_000 },
  "claude-haiku-4-5": { adaptiveThinking: false, effortControl: false, maxOutput: 64_000 },
};

/**
 * Fable narration always configures server-side fallback to Opus 4.8 (§3):
 * a safety-classifier decline is transparently re-served by the fallback
 * inside the same call, repriced at the fallback's own rates. Any fallback
 * event lands in the trace as Sakkan-relevant (the voice shifted).
 */
export const FABLE_MODEL = "claude-fable-5";
export const FABLE_FALLBACK_MODEL = "claude-opus-4-8";
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";
