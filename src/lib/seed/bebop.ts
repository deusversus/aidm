import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@/lib/db";
import { anthropicFallbackConfig } from "@/lib/providers";
import { campaigns, characters, profiles } from "@/lib/state/schema";
import { Profile } from "@/lib/types/profile";
import { and, eq, isNull } from "drizzle-orm";
import jsYaml from "js-yaml";

/**
 * Reusable seed — Cowboy Bebop profile + Spike character + a playable
 * campaign. Shared by `pnpm seed:campaign` (dev CLI) and the Clerk
 * webhook (auto-seed on first sign-in, so the player can hit prod and
 * play without running any manual commands).
 *
 * Idempotent: upserts the profile by slug and creates the campaign
 * only if the user doesn't already have one named CAMPAIGN_NAME.
 */

const BEBOP_FIXTURE_PATH = join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml");

export const BEBOP_CAMPAIGN_NAME = "Bebop — Red Entry";
export const BEBOP_PROFILE_SLUG = "cowboy-bebop";

export const SPIKE_CHARACTER = {
  name: "Spike Spiegel",
  concept:
    "Ex-syndicate enforcer turned reluctant bounty hunter. Tall, lean, hair perpetually in his face. Moves like someone who's already resigned himself to dying and finds that funny. Carries a Jericho 941. Owes money.",
  power_tier: "T9",
  sheet: {
    available: true,
    name: "Spike Spiegel",
    concept: "Bounty hunter, ex-Red Dragon enforcer, Jeet Kune Do stylist.",
    power_tier: "T9",
    stats: { STR: 13, DEX: 16, CON: 12, INT: 13, WIS: 11, CHA: 14 },
    abilities: [
      {
        name: "Jeet Kune Do",
        description:
          "Fluid striking art. Reads openings fast; prefers to let the opponent commit then redirect.",
        limitations: "No supernatural enhancement. Spike bleeds like anyone else.",
      },
      {
        name: "Marksmanship (Jericho 941)",
        description: "Accurate under pressure; trick-shots in close quarters.",
        limitations: "Ammunition is finite. Shaky grouping beyond 40m.",
      },
    ],
    inventory: [
      { name: "Jericho 941", description: "Spike's pistol. 16+1 rounds." },
      { name: "Worn blue suit, yellow shirt", description: "His uniform." },
      { name: "Cigarettes (half pack)", description: "He'll finish it before the session ends." },
    ],
    stat_mapping: null,
    current_state: { hp: 30, status_effects: [] },
  },
} as const;

function loadBebopProfile(): Profile {
  const raw = readFileSync(BEBOP_FIXTURE_PATH, "utf8");
  return Profile.parse(jsYaml.load(raw));
}

interface SeedResult {
  profileId: string;
  campaignId: string;
  characterId: string;
  created: boolean; // true if a new campaign was created, false if re-using existing
}

/**
 * Ensure the Bebop profile exists (upsert by slug) and the user has a
 * playable Bebop campaign. Safe to call repeatedly — re-running won't
 * create duplicate campaigns or reset an in-flight campaign's state.
 */
export async function seedBebopCampaign(db: Db, userId: string): Promise<SeedResult> {
  const bebop = loadBebopProfile();

  // 1. Upsert profile by slug (shared across all users)
  const [existingProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.slug, BEBOP_PROFILE_SLUG))
    .limit(1);
  let profileId: string;
  if (existingProfile) {
    profileId = existingProfile.id;
    await db
      .update(profiles)
      .set({ title: bebop.title, mediaType: bebop.media_type, content: bebop })
      .where(eq(profiles.id, profileId));
  } else {
    const [created] = await db
      .insert(profiles)
      .values({
        slug: BEBOP_PROFILE_SLUG,
        title: bebop.title,
        mediaType: bebop.media_type,
        content: bebop,
      })
      .returning({ id: profiles.id });
    if (!created) throw new Error("profile insert returned nothing");
    profileId = created.id;
  }

  // 2. Check for existing campaign by (user, name). If present, skip —
  //    don't clobber a campaign the player may have turns in.
  const [existingCampaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.name, BEBOP_CAMPAIGN_NAME),
        isNull(campaigns.deletedAt),
      ),
    )
    .limit(1);

  // New-campaign seed includes the M1.5 multi-provider fields — provider
  // + tier_models — so every campaign created after M1.5 lands with a
  // well-formed provider config. Defaults to Anthropic via
  // anthropicFallbackConfig(); user retunes via settings UI (Commit F).
  const providerConfig = anthropicFallbackConfig();
  const settings = {
    provider: providerConfig.provider,
    tier_models: providerConfig.tier_models,
    active_dna: bebop.canonical_dna,
    active_composition: bebop.canonical_composition,
    world_state: {
      location: "The Bebop, docked in Ganymede drift traffic",
      situation:
        "Spike's waking up. The bounty board on the screen is blinking. Faye and Jet are arguing about something trivially important.",
      time_context: "Morning-ish. Station time means nothing out here.",
      arc_phase: "setup",
      tension_level: 0.2,
      present_npcs: ["Jet Black", "Faye Valentine", "Ein"],
    },
    overrides: [] as unknown[],
  };

  if (existingCampaign) {
    // Ensure character exists; re-insert nothing else.
    const [ch] = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.campaignId, existingCampaign.id))
      .limit(1);
    if (!ch) {
      const [chNew] = await db
        .insert(characters)
        .values({
          campaignId: existingCampaign.id,
          name: SPIKE_CHARACTER.name,
          concept: SPIKE_CHARACTER.concept,
          powerTier: SPIKE_CHARACTER.power_tier,
          sheet: SPIKE_CHARACTER.sheet,
        })
        .returning({ id: characters.id });
      if (!chNew) throw new Error("character insert returned nothing");
      return {
        profileId,
        campaignId: existingCampaign.id,
        characterId: chNew.id,
        created: false,
      };
    }
    return {
      profileId,
      campaignId: existingCampaign.id,
      characterId: ch.id,
      created: false,
    };
  }

  // 3. Create campaign + character in one shot
  const [campaign] = await db
    .insert(campaigns)
    .values({
      userId,
      name: BEBOP_CAMPAIGN_NAME,
      phase: "playing",
      profileRefs: [BEBOP_PROFILE_SLUG],
      settings,
    })
    .returning({ id: campaigns.id });
  if (!campaign) throw new Error("campaign insert returned nothing");

  const [character] = await db
    .insert(characters)
    .values({
      campaignId: campaign.id,
      name: SPIKE_CHARACTER.name,
      concept: SPIKE_CHARACTER.concept,
      powerTier: SPIKE_CHARACTER.power_tier,
      sheet: SPIKE_CHARACTER.sheet,
    })
    .returning({ id: characters.id });
  if (!character) throw new Error("character insert returned nothing");

  return {
    profileId,
    campaignId: campaign.id,
    characterId: character.id,
    created: true,
  };
}
