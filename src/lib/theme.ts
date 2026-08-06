/**
 * The reading theme (M3R4 B5). Player-scoped, not campaign-scoped: it is
 * cross-campaign taste (layer 10, §6.9) — "different people have different
 * eyes and prefer different things, esp for reading a lot" — so it lives in
 * `players.profile` and follows the player across devices and campaigns.
 *
 * Deliberately zod-free and DB-free: this module is imported by the client
 * settings drawer as well as the server, and neither the validator nor the
 * pool belongs in that bundle. The route builds its zod enum from THEMES.
 */

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

/** Absent preference = dark. The app has only ever rendered dark; that stays the default. */
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/** Reads the preference out of a `players.profile` jsonb; anything unreadable is the default. */
export function themeFromProfile(profile: unknown): Theme {
  if (!profile || typeof profile !== "object") return DEFAULT_THEME;
  const value = (profile as { theme?: unknown }).theme;
  return isTheme(value) ? value : DEFAULT_THEME;
}
