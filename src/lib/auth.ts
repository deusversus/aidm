import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Shape every caller sees. Extra Clerk fields (avatars, public metadata, etc.)
 * should flow through this helper rather than leak across the codebase.
 */
export type AppUser = {
  id: string;
  email: string | null;
};

/**
 * The id alone, read off the session claims — no Clerk API round-trip. The root
 * layout runs on every page render and only needs to key a preference lookup;
 * `currentUser()` would put a network hop in front of every navigation.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const u = await currentUser();
  if (!u) return null;
  return {
    id: u.id,
    email: u.emailAddresses[0]?.emailAddress ?? null,
  };
}
