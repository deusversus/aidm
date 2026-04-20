import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  type CampaignProviderConfig,
  type ProviderDefinition,
  anthropicFallbackConfig,
  listProviders,
} from "@/lib/providers";
import { campaigns } from "@/lib/state/schema";
import { CampaignSettings } from "@/lib/types/campaign-settings";
import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import SettingsUI from "./settings-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Campaign settings — provider + tier_models selection.
 *
 * Loads the campaign server-side (auth-gated, must own it), parses its
 * current settings via `CampaignSettings`, and hands both the provider
 * registry snapshot and the current config to the client form. The
 * client renders dropdowns; the Server Action writes back.
 */
export default async function CampaignSettingsPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const db = getDb();

  const [campaign] = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      settings: campaigns.settings,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) notFound();

  const parsed = CampaignSettings.safeParse(campaign.settings ?? {});
  const current: CampaignProviderConfig =
    parsed.success && parsed.data.provider && parsed.data.tier_models
      ? { provider: parsed.data.provider, tier_models: parsed.data.tier_models }
      : anthropicFallbackConfig();

  // `listProviders` returns the full registry snapshot. The client
  // renders all four provider slots (disabled entries for unavailable
  // ones, with unavailableReason as hover-title) so users see what's
  // coming without us inventing a separate "roadmap" surface.
  const providers: ProviderDefinition[] = listProviders();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
        <p className="text-muted-foreground text-sm">
          Provider + model selection for this campaign. Changes take effect on the next turn;
          existing turns keep the voice they were written in.
        </p>
      </header>

      <SettingsUI campaignId={campaign.id} providers={providers} current={current} />
    </div>
  );
}
