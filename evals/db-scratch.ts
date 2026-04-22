import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@/lib/db";
import { anthropicFallbackConfig } from "@/lib/providers";
import { campaigns, characters, profiles, users } from "@/lib/state/schema";
import { Profile } from "@/lib/types/profile";
import { eq } from "drizzle-orm";
import jsYaml from "js-yaml";
import type { GoldenFixture } from "./types";

/**
 * Seed a throwaway user + profile + campaign + character per scenario.
 *
 * The eval harness runs against whatever DATABASE_URL is configured
 * (`EVAL_DB_URL` override lands in CI). Each run produces a fresh
 * campaign slug so two concurrent eval runs don't stomp each other.
 */

const PROFILES_DIR = join(process.cwd(), "evals", "golden", "profiles");

interface ScratchRefs {
  userId: string;
  profileId: string;
  campaignId: string;
  characterId: string;
}

export async function seedScratchCampaign(
  db: Db,
  fixture: GoldenFixture,
  runId: string,
): Promise<ScratchRefs> {
  // 1. Ephemeral eval user — one per run, so concurrent eval workflows
  //    don't collide. Stable enough across scenarios within one run.
  const userId = `eval-${runId}`;
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@eval.aidm.local` })
    .onConflictDoNothing();

  // 2. Profile — upsert by slug (shared across scenarios that use the
  //    same IP; both bebop scenarios and solo-leveling scenarios
  //    re-land the same profile file).
  const profilePath = join(PROFILES_DIR, `${fixture.profile_slug.replace(/-/g, "_")}.yaml`);
  const profileRaw = readFileSync(profilePath, "utf8");
  const profile = Profile.parse(jsYaml.load(profileRaw));
  const [existingProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.slug, fixture.profile_slug))
    .limit(1);
  let profileId: string;
  if (existingProfile) {
    profileId = existingProfile.id;
  } else {
    const [row] = await db
      .insert(profiles)
      .values({
        slug: fixture.profile_slug,
        title: profile.title,
        mediaType: profile.media_type,
        content: profile,
      })
      .returning({ id: profiles.id });
    if (!row) throw new Error("profile insert returned nothing");
    profileId = row.id;
  }

  // 3. Campaign — unique name per (runId, scenario).
  const campaignName = `eval:${runId}:${fixture.id}`;
  const providerConfig = anthropicFallbackConfig();
  const settings = {
    provider: providerConfig.provider,
    tier_models: providerConfig.tier_models,
    active_dna: profile.canonical_dna,
    active_composition: profile.canonical_composition,
    world_state: {
      location: "eval harness",
      situation: fixture.last_turns_summary || "opening beat",
      time_context: "eval time",
      arc_phase: "setup",
      tension_level: 0.2,
      present_npcs: [],
    },
    overrides: [],
  };
  const [campaign] = await db
    .insert(campaigns)
    .values({
      userId,
      name: campaignName,
      phase: "playing",
      profileRefs: [fixture.profile_slug],
      settings,
    })
    .returning({ id: campaigns.id });
  if (!campaign) throw new Error("campaign insert returned nothing");

  // 4. Character.
  const [character] = await db
    .insert(characters)
    .values({
      campaignId: campaign.id,
      name: fixture.character.name,
      concept: fixture.character.concept,
      powerTier: fixture.character.power_tier,
      sheet: fixture.character.sheet,
    })
    .returning({ id: characters.id });
  if (!character) throw new Error("character insert returned nothing");

  return { userId, profileId, campaignId: campaign.id, characterId: character.id };
}
