"use server";

import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { CampaignProviderValidationError } from "@/lib/providers";
import { campaigns } from "@/lib/state/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mergeSettingsWithProviderConfig, serializeProviderConfigToken } from "./merge";

/**
 * Save a campaign's provider + tier_models choice.
 *
 * Auth: current user must own the campaign. Validation: provider must
 * be `available: true` in the registry, and every tier_model must be
 * in that provider's selectable list (unless the provider has
 * `allowFreeFormModels`). On failure, returns a user-facing message
 * rather than throwing — the form re-renders with the error.
 *
 * Merge semantics: reads the existing settings blob, overwrites just
 * `provider` and `tier_models`, leaves every other field intact
 * (active_dna, world_state, overrides, voice_patterns, etc.). Next
 * turn's `resolveModelContext` picks up the new values immediately;
 * no campaign-state churn.
 */

export type SaveModelContextResult = { ok: true } | { ok: false; code: string; message: string };

export async function saveCampaignModelContext(
  campaignId: string,
  input: unknown,
  /**
   * Opaque token produced at page load via `serializeProviderConfigToken`.
   * Undefined for legacy callers (pre-FU-1) — skip the stale check in
   * that case so we don't break existing consumers during deploy.
   * New form submits always pass it.
   */
  configToken?: string,
): Promise<SaveModelContextResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, code: "unauthenticated", message: "Please sign in again." };
  }

  const db = getDb();

  // Fetch existing campaign + settings. Must belong to this user.
  const [row] = await db
    .select({ settings: campaigns.settings })
    .from(campaigns)
    .where(
      and(eq(campaigns.id, campaignId), eq(campaigns.userId, user.id), isNull(campaigns.deletedAt)),
    )
    .limit(1);

  if (!row) {
    return {
      ok: false,
      code: "campaign_not_found",
      message: "Campaign not found or not yours.",
    };
  }

  // Optimistic concurrency check (FU-1). Token was computed at page
  // load; re-compute from the current DB row. If they don't match,
  // another tab saved between the user's load and submit — surface a
  // stale-save error with a reload prompt rather than silently
  // overwriting their sibling tab's changes.
  if (configToken !== undefined) {
    const currentToken = serializeProviderConfigToken(row.settings);
    if (currentToken !== configToken) {
      return {
        ok: false,
        code: "stale_config",
        message:
          "This campaign's settings changed in another tab or session. Reload the page to see the latest and try again.",
      };
    }
  }

  // Merge + validate via the pure helper. Any shape or registry
  // problem throws a CampaignProviderValidationError which we surface
  // to the form.
  let nextSettings: Record<string, unknown>;
  try {
    nextSettings = mergeSettingsWithProviderConfig(row.settings, input);
  } catch (err) {
    if (err instanceof CampaignProviderValidationError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: "validation_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await db.update(campaigns).set({ settings: nextSettings }).where(eq(campaigns.id, campaignId));

  // Invalidate the play and settings pages so SSR picks up the new
  // provider on the next navigation. The write has already committed
  // above — if revalidate throws here, we still return ok: true so
  // the user isn't shown an error for a successful save. Stale
  // caches recover on the next real navigation anyway.
  try {
    revalidatePath(`/campaigns/${campaignId}/play`);
    revalidatePath(`/campaigns/${campaignId}/settings`);
  } catch (err) {
    console.warn("saveCampaignModelContext: revalidatePath failed (write already committed)", {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true };
}
