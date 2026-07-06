/**
 * Seed / re-seed the Bebop campaign for one user.
 *
 * You usually don't need to run this — the Clerk webhook auto-seeds on
 * first sign-in, so signing in at prod is enough to land on a playable
 * campaign. This script exists for:
 *   - re-seeding from dev when the fixture changes (updates the profile
 *     row; leaves existing campaign state alone)
 *   - manually creating a campaign for a user whose webhook didn't fire
 *     (rare — Railway deploy during sign-in, etc.)
 *
 * Usage (with .env.local loaded):
 *   pnpm seed:campaign                       # seeds against first user
 *   pnpm seed:campaign --user-id <clerk-id>  # seeds against a specific user
 */
import { getDb } from "@/lib/db";
import { seedBebopCampaign } from "@/lib/seed/bebop";
import { users } from "@/lib/state/schema";
import { isNull } from "drizzle-orm";

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
        "No users in DB. Sign in on the deployed app first (the webhook creates the user row).",
      );
      process.exit(1);
    }
    userId = firstUser.id;
    console.log(`Seeding against user: ${firstUser.email} (${firstUser.id})`);
  }

  const result = await seedBebopCampaign(db, userId);
  console.log(
    result.created
      ? `Created campaign ${result.campaignId} for user ${userId}`
      : `Campaign already exists: ${result.campaignId} (left alone)`,
  );
  console.log(`Visit /campaigns/${result.campaignId}/play to start.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
