import { CampaignProviderConfig } from "@/lib/providers";
import { z } from "zod";

/**
 * Zod shape of the `campaigns.settings` jsonb blob.
 *
 * The DB column is `jsonb` so the shape can evolve without migrations
 * mid-arc. This Zod type is the loose runtime validator — every field
 * is optional with a safe default, because historical rows may lack
 * fields that later milestones add.
 *
 * Read pattern: parse on load via `CampaignSettings.parse(settings)`.
 * Unknown fields are kept (passthrough) so forward-compat rows don't
 * lose data when older code loads them.
 *
 * M1.5 additions (2026-04-20): `provider` + `tier_models` — per-campaign
 * multi-provider config. See `src/lib/providers/` for the registry the
 * values validate against. Historical campaigns back-filled via
 * `scripts/migrate-campaign-providers.ts`; new campaigns seeded with
 * `anthropicFallbackConfig()`.
 */

const WorldState = z
  .object({
    location: z.string().nullable().optional(),
    situation: z.string().nullable().optional(),
    time_context: z.string().nullable().optional(),
    arc_phase: z.string().nullable().optional(),
    tension_level: z.number().min(0).max(1).nullable().optional(),
    present_npcs: z.array(z.string()).optional(),
  })
  .passthrough();

const OverrideCategory = z.enum([
  "NPC_PROTECTION",
  "CONTENT_CONSTRAINT",
  "NARRATIVE_DEMAND",
  "TONE_REQUIREMENT",
]);

const Override = z.object({
  id: z.string(),
  category: OverrideCategory,
  value: z.string(),
  scope: z.enum(["campaign", "session", "arc"]).optional(),
  created_at: z.string().optional(),
});

const ArcPlan = z
  .object({
    current_arc: z.string().nullable().optional(),
    arc_phase: z.string().nullable().optional(),
    tension_level: z.number().min(0).max(1).nullable().optional(),
  })
  .passthrough();

const VoicePatterns = z.object({
  patterns: z.array(z.string()).default([]),
});

export const CampaignSettings = z
  .object({
    // M1: tonal state + world state + overrides.
    active_dna: z.unknown().optional(),
    active_composition: z.unknown().optional(),
    arc_override: z.unknown().optional(),
    world_state: WorldState.optional(),
    overrides: z.array(Override).optional(),

    // M1 v3-soul extras — populated as Director / Chronicler land.
    voice_patterns: VoicePatterns.optional(),
    director_notes: z.array(z.string()).optional(),
    arc_plan: ArcPlan.optional(),
    canon_rules: z.array(z.string()).optional(),

    // M1.5 — per-campaign provider + tier_models. Optional here so
    // legacy (pre-migration) rows don't fail parse; validated via
    // providers/registry.ts when read by the runtime hot path.
    provider: CampaignProviderConfig.shape.provider.optional(),
    tier_models: CampaignProviderConfig.shape.tier_models.optional(),
  })
  .passthrough();

export type CampaignSettings = z.infer<typeof CampaignSettings>;

/**
 * Has this settings row been migrated to include provider + tier_models?
 * False means `scripts/migrate-campaign-providers.ts` hasn't run on it yet.
 */
export function hasProviderConfig(settings: CampaignSettings): boolean {
  return !!settings.provider && !!settings.tier_models;
}
