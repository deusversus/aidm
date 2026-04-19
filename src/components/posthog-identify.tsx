"use client";

import { useUser } from "@clerk/nextjs";
import posthog from "posthog-js";
import { useEffect } from "react";

/**
 * Mirrors Clerk auth state into PostHog. Runs as a client component embedded
 * inside the authenticated layout so it only mounts after ClerkProvider is
 * initialized.
 */
export function PostHogIdentify() {
  const { user, isLoaded } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (!posthog.__loaded) return;
    if (user) {
      posthog.identify(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
      });
    } else {
      posthog.reset();
    }
  }, [isLoaded, user]);

  return null;
}
