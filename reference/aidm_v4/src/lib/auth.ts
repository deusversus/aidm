import { currentUser } from "@clerk/nextjs/server";

/**
 * Shape every caller sees. Extra Clerk fields (avatars, public metadata, etc.)
 * should flow through this helper rather than leak across the codebase.
 */
export type AppUser = {
  id: string;
  email: string | null;
};

export async function getCurrentUser(): Promise<AppUser | null> {
  const u = await currentUser();
  if (!u) return null;
  return {
    id: u.id,
    email: u.emailAddresses[0]?.emailAddress ?? null,
  };
}
