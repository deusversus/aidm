import { PostHogProvider } from "@/components/posthog-provider";
import { getCurrentUserId } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { readPlayerTheme } from "@/lib/db/helpers";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIDM",
  description: "An engine for co-telling long-form fiction that stays true to a premise.",
};

/**
 * The theme is stamped server-side (M3R4 B5) so a reload or a fresh page keeps
 * the player's choice with no flash of the other theme. Signed-out surfaces and
 * any failure — Clerk unreachable, DB down — read as dark, the default: a
 * preference lookup must never be able to take the whole app down.
 */
async function currentTheme(): Promise<Theme> {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return DEFAULT_THEME;
    return await readPlayerTheme(getDb(), userId);
  } catch (err) {
    // `auth()` reads headers, so prerendering throws DynamicServerError to mark
    // the route dynamic. That is Next's control flow, not a failure: rethrow it
    // (swallowing it hides the bailout) and keep it out of the log.
    if ((err as { digest?: unknown } | null)?.digest === "DYNAMIC_SERVER_USAGE") throw err;
    // Everything else is swallowed on purpose — but never silently: a DB or
    // Clerk outage that downgrades every page to dark should be visible in the
    // logs, not inferred from "the theme toggle stopped working."
    console.warn("[layout] theme lookup failed; falling back to the default", err);
    return DEFAULT_THEME;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await currentTheme();
  return (
    <ClerkProvider>
      <html lang="en" data-theme={theme}>
        <body className="min-h-screen bg-background text-foreground antialiased">
          <PostHogProvider>{children}</PostHogProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
