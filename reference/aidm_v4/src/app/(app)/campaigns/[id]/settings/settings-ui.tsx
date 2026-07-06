"use client";

import type {
  CampaignProviderConfig,
  ProviderDefinition,
  ProviderId,
  TierModels,
  TierName,
} from "@/lib/providers";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { saveCampaignModelContext } from "./actions";

interface Props {
  campaignId: string;
  providers: ProviderDefinition[];
  current: CampaignProviderConfig;
  /**
   * Opaque concurrency token serialized at page load. Passed back to
   * the Server Action; if the DB's current provider/tier_models no
   * longer serialize to this same string, another tab saved between
   * our load and our submit, and we reject with a "stale" error
   * prompting a reload. Scoped to provider+tier_models only so
   * unrelated background writes don't spuriously conflict.
   */
  configToken: string;
}

const USER_FACING_TIERS: TierName[] = ["fast", "thinking", "creative"];
const TIER_LABELS: Record<TierName, string> = {
  probe: "Probe (reachability)",
  fast: "Fast",
  thinking: "Thinking",
  creative: "Creative",
};
const TIER_DESCRIPTIONS: Record<TierName, string> = {
  probe: "",
  fast: "Classification, rerankers, recap. Cheap + quick.",
  thinking: "OutcomeJudge, Validator, Pacing, Combat. Reasoning-heavy.",
  creative: "KeyAnimator — the voice the player reads. This is what prose quality hinges on.",
};

/**
 * Soft warnings for incoherent-but-allowed tier-model combinations.
 * These don't block save; they're advisory so the user knows what
 * they're choosing. Returning an empty string means no warning.
 */
function incoherenceWarning(tier: TierName, model: string): string {
  if (tier === "thinking" && /haiku/i.test(model)) {
    return "Haiku models don't support extended thinking — the thinking budget will be ignored.";
  }
  if (tier === "creative" && /haiku/i.test(model)) {
    return "Haiku on creative tier will degrade prose quality meaningfully — use for ultra-cheap exploration only.";
  }
  if (/claude-3-haiku/.test(model)) {
    return "claude-3-haiku is an older snapshot — structured output is less reliable; expect more retries / fallbacks.";
  }
  return "";
}

export default function SettingsUI({ campaignId, providers, current, configToken }: Props) {
  const [providerId, setProviderId] = useState<ProviderId>(current.provider);
  const [tierModels, setTierModels] = useState<TierModels>(current.tier_models);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ kind: "ok" } | { kind: "error"; message: string } | null>(
    null,
  );
  // Form inputs are disabled during submit (FU-5) and when the picked
  // provider isn't yet available (FU-3; OpenRouter / Google / OpenAI
  // pre-M3.5/M5.5). Prevents the "form looks live but save is
  // blocked" confusion.
  const activeProviderAvailable = providers.find((p) => p.id === providerId)?.available ?? false;
  const inputsDisabled = pending || !activeProviderAvailable;

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  );

  function onProviderChange(nextId: ProviderId) {
    const next = providers.find((p) => p.id === nextId);
    if (!next) return;
    setProviderId(nextId);
    // Reset tier_models to the new provider's defaults. Probe stays
    // Haiku universally (provider entries carry the same default).
    setTierModels({
      probe: next.tiers.probe.defaultModel,
      fast: next.tiers.fast.defaultModel,
      thinking: next.tiers.thinking.defaultModel,
      creative: next.tiers.creative.defaultModel,
    });
    setResult(null);
  }

  function onTierChange(tier: TierName, model: string) {
    setTierModels((prev) => ({ ...prev, [tier]: model }));
    setResult(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const res = await saveCampaignModelContext(
        campaignId,
        { provider: providerId, tier_models: tierModels },
        configToken,
      );
      if (res.ok) {
        setResult({ kind: "ok" });
      } else {
        setResult({ kind: "error", message: res.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <label htmlFor="provider" className="font-medium text-sm">
          Provider
        </label>
        <select
          id="provider"
          value={providerId}
          onChange={(e) => onProviderChange(e.target.value as ProviderId)}
          disabled={pending}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        >
          {/*
            `title` on disabled <option> elements isn't shown by most
            browsers — we surface the unavailable-reason below the
            select when that provider is selected (see the destructive
            paragraph below). Keeping "— coming soon" in the visible
            label so users can scan without picking.
          */}
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.displayName}
              {p.available ? "" : " — coming soon"}
            </option>
          ))}
        </select>
        {activeProvider && !activeProvider.available ? (
          <p className="text-destructive text-xs">{activeProvider.unavailableReason}</p>
        ) : null}
      </section>

      {USER_FACING_TIERS.map((tier) => {
        if (!activeProvider) return null;
        const roster = activeProvider.tiers[tier].selectableModels;
        const picked = tierModels[tier];
        const warning = incoherenceWarning(tier, picked);
        const allowFreeForm = activeProvider.allowFreeFormModels;

        return (
          <section key={tier} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
              <label htmlFor={`tier-${tier}`} className="font-medium text-sm">
                {TIER_LABELS[tier]}
              </label>
              <span className="text-muted-foreground text-xs">{TIER_DESCRIPTIONS[tier]}</span>
            </div>
            {allowFreeForm ? (
              <input
                id={`tier-${tier}`}
                type="text"
                value={picked}
                onChange={(e) => onTierChange(tier, e.target.value)}
                disabled={inputsDisabled}
                placeholder="Enter OpenRouter model ID (e.g. openai/gpt-4o)"
                className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
            ) : (
              <select
                id={`tier-${tier}`}
                value={picked}
                onChange={(e) => onTierChange(tier, e.target.value)}
                disabled={inputsDisabled || roster.length === 0}
                className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              >
                {roster.length === 0 ? (
                  <option value="">(no models available yet)</option>
                ) : (
                  roster.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                )}
              </select>
            )}
            {warning ? <p className="text-muted-foreground text-xs italic">{warning}</p> : null}
          </section>
        );
      })}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !activeProvider?.available}
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? "saving…" : "save"}
        </button>
        <Link
          href={`/campaigns/${campaignId}/play`}
          className="text-muted-foreground text-sm hover:text-foreground"
        >
          back to play
        </Link>
        {result?.kind === "ok" ? (
          <span className="text-emerald-600 text-sm dark:text-emerald-400">saved</span>
        ) : null}
      </div>

      {result?.kind === "error" ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
          {result.message}
        </div>
      ) : null}
    </form>
  );
}
