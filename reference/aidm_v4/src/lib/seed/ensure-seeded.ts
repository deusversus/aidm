import type { AppUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/state/schema";
import { seedBebopCampaign } from "./bebop";

/**
 * Belt-and-suspenders backfill: upsert the Drizzle `users` row + make
 * sure the player has the Bebop demo campaign. Runs on `/campaigns`
 * load so anyone who slips past the Clerk `user.created` webhook —
 * accounts that predate the webhook, webhook delivery failures, local
 * dev without a tunnel — still gets a playable campaign on first
 * visit. The Clerk webhook is still the primary path; this is the
 * safety net.
 *
 * Both operations are idempotent:
 *   - users: onConflictDoNothing on (id)
 *   - seedBebopCampaign: upserts profile by slug, skips campaign
 *     creation if one with BEBOP_CAMPAIGN_NAME already exists
 *
 * Cost: ~2-3 selects on a warm path (existing user + campaign). The
 * campaigns page is not hot enough for this to matter.
 */
export async function ensureUserSeeded(user: AppUser): Promise<void> {
  if (!user.email) return;
  const db = getDb();
  await db.insert(users).values({ id: user.id, email: user.email }).onConflictDoNothing();
  await seedBebopCampaign(db, user.id);
}
