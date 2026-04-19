"use client";

import posthog from "posthog-js";
import { PostHogProvider as ProviderRoot } from "posthog-js/react";
import { type ReactNode, useEffect } from "react";

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    // Guard against double-init during React StrictMode or HMR.
    if (posthog.__loaded) return;
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // Only create a Person profile once we identify the user. Anonymous
      // traffic still gets tracked as events but doesn't inflate MAUs.
      person_profiles: "identified_only",
      // Track pageviews via Next.js router history changes, not full reloads.
      capture_pageview: "history_change",
      capture_pageleave: true,
      autocapture: true,
      // posthog-js autocapture does NOT include JS exceptions by default.
      // Explicit opt-in so the Error Tracking product has data. M2+ when
      // chat UI lands: revisit mask_all_text for sensitive SZ content.
      capture_exceptions: true,
    });
  }, []);

  return <ProviderRoot client={posthog}>{children}</ProviderRoot>;
}
