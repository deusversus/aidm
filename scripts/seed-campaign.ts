import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Seed a playable campaign — Cowboy Bebop profile + Spike Spiegel
 * character + one campaign, owned by the first user in the `users`
 * table (i.e. whoever signed in first on prod).
 *
 * Idempotent: re-running upserts the profile by slug, replaces the
 * campaign named "Bebop — Red Entry", and resets the character sheet.
 * Safe to run against prod Railway.
 *
 * Usage (from dev machine with .env.local loaded):
 *   pnpm tsx scripts/seed-campaign.ts [--user-id <clerk-id>]
 *
 * If --user-id is omitted, seeds against the first user row. On a
 * fresh DB with no users, exits with a helpful message.
 */
import { getDb } from "@/lib/db";
import { campaigns, characters, profiles, users } from "@/lib/state/schema";
import { Profile } from "@/lib/types/profile";
import { and, eq, isNull } from "drizzle-orm";
import jsYaml from "js-yaml";

const BEBOP_FIXTURE_PATH = join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml");

const CAMPAIGN_NAME = "Bebop — Red Entry";

const spikeCharacter = {
  name: "Spike Spiegel",
  concept:
    "Ex-syndicate enforcer turned reluctant bounty hunter. Tall, lean, hair perpetually in his face. Moves like someone who's already resigned himself to dying and finds that funny. Carries a Jericho 941. Owes money.",
  power_tier: "T9",
  sheet: {
    available: true,
    name: "Spike Spiegel",
    concept: "Bounty hunter, ex-Red Dragon enforcer, Jeet Kune Do stylist.",
    power_tier: "T9",
    stats: {
      STR: 13,
      DEX: 16,
      CON: 12,
      INT: 13,
      WIS: 11,
      CHA: 14,
    },
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
      {
        name: "Cigarettes (half pack)",
        description: "He'll finish it before the session ends.",
      },
    ],
    stat_mapping: null,
    current_state: { hp: 30, status_effects: [] },
  },
} as const;

function loadBebopProfile(): Profile {
  const raw = readFileSync(BEBOP_FIXTURE_PATH, "utf8");
  const parsed = jsYaml.load(raw);
  return Profile.parse(parsed);
}

async function main() {
  const db = getDb();
  const args = process.argv.slice(2);
  const userIdFlagIdx = args.indexOf("--user-id");
  const explicitUserId = userIdFlagIdx !== -1 ? args[userIdFlagIdx + 1] : undefined;

  let userId = explicitUserId;
  if (!userId) {
    const [firstUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(isNull(users.deletedAt))
      .limit(1);
    if (!firstUser) {
      console.error(
        "No users in DB. Sign in at least once on the deployed app, then re-run with --user-id <your clerk id> or without flags to pick up the first user.",
      );
      process.exit(1);
    }
    userId = firstUser.id;
    console.log(`Seeding against user: ${firstUser.email} (${firstUser.id})`);
  }

  // 1. Upsert profile by slug
  const bebop = loadBebopProfile();
  const slug = "cowboy-bebop";
  const [existingProfile] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.slug, slug))
    .limit(1);
  let profileId: string;
  if (existingProfile) {
    profileId = existingProfile.id;
    await db
      .update(profiles)
      .set({ title: bebop.title, mediaType: bebop.media_type, content: bebop })
      .where(eq(profiles.id, profileId));
    console.log(`Updated profile: ${bebop.title} (${profileId})`);
  } else {
    const [created] = await db
      .insert(profiles)
      .values({
        slug,
        title: bebop.title,
        mediaType: bebop.media_type,
        content: bebop,
      })
      .returning({ id: profiles.id });
    if (!created) throw new Error("profile insert returned nothing");
    profileId = created.id;
    console.log(`Created profile: ${bebop.title} (${profileId})`);
  }

  // 2. Upsert campaign by (user, name)
  const [existingCampaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.userId, userId),
        eq(campaigns.name, CAMPAIGN_NAME),
        isNull(campaigns.deletedAt),
      ),
    )
    .limit(1);

  // Campaign settings carry the player-active tonal state + world_state.
  // For M1 we start with canonical DNA + composition (no divergence).
  const settings = {
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

  let campaignId: string;
  if (existingCampaign) {
    campaignId = existingCampaign.id;
    await db
      .update(campaigns)
      .set({
        phase: "playing",
        profileRefs: [slug],
        settings,
      })
      .where(eq(campaigns.id, campaignId));
    console.log(`Updated campaign: ${CAMPAIGN_NAME} (${campaignId})`);
  } else {
    const [created] = await db
      .insert(campaigns)
      .values({
        userId,
        name: CAMPAIGN_NAME,
        phase: "playing",
        profileRefs: [slug],
        settings,
      })
      .returning({ id: campaigns.id });
    if (!created) throw new Error("campaign insert returned nothing");
    campaignId = created.id;
    console.log(`Created campaign: ${CAMPAIGN_NAME} (${campaignId})`);
  }

  // 3. Upsert character (one per campaign per M1 shape)
  const [existingCharacter] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.campaignId, campaignId))
    .limit(1);
  if (existingCharacter) {
    await db
      .update(characters)
      .set({
        name: spikeCharacter.name,
        concept: spikeCharacter.concept,
        powerTier: spikeCharacter.power_tier,
        sheet: spikeCharacter.sheet,
      })
      .where(eq(characters.id, existingCharacter.id));
    console.log(`Updated character: ${spikeCharacter.name}`);
  } else {
    await db.insert(characters).values({
      campaignId,
      name: spikeCharacter.name,
      concept: spikeCharacter.concept,
      powerTier: spikeCharacter.power_tier,
      sheet: spikeCharacter.sheet,
    });
    console.log(`Created character: ${spikeCharacter.name}`);
  }

  console.log("\nSeed complete. Campaign id:", campaignId);
  console.log(`Visit /campaigns/${campaignId}/play to start.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
