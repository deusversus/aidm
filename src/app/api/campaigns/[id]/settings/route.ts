import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { TIER_MENUS, TierSelection } from "@/lib/llm/tiers";
import { availableVoices, ttsConfigured } from "@/lib/tts/elevenlabs";
import { PremiseContract, SuggestionAffordance } from "@/lib/types/premise";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The decided capabilities' surface (M2 C5). EXACTLY two things are writable
 * post-compile: the tier menus (§13 decision 1 — "changeable anytime with
 * cache-reset + voice-shift warning") and suggestion_affordance (§9.2, a
 * calibration the player owns). Every other contract field — DNA, framing,
 * canonicality, voice, intensity — waits for M4's gated studio view (§13.4);
 * the strict body schema below is that boundary, enforced server-side.
 *
 * Tier "cache reset" is inherent: Anthropic prompt caching is namespaced per
 * model, so a changed tier simply rebuilds cold on the next turn — the
 * studio-handoff warning's whole cost. No local state invalidates.
 */

const SettingsPatch = z
  .object({
    narration: z.enum(TIER_MENUS.narration).optional(),
    judgment: z.enum(TIER_MENUS.judgment).optional(),
    probe: z.enum(TIER_MENUS.probe).optional(),
    suggestion_affordance: SuggestionAffordance.optional(),
    /** §9.5 voice preference (listen button) — a machinery preference like
     *  the tier menus, NOT a premise-contract field; validated against the
     *  available voice set in the handler. */
    voice_id: z.string().min(1).optional(),
  })
  .strict();

interface SettingsLogEntry {
  at: string;
  field: string;
  from: string;
  to: string;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign || campaign.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const tiers = TierSelection.safeParse(campaign.tierModels);
  const contract = campaign.premiseContract as { suggestion_affordance?: string } | null;
  // §9.5 voice options: the player's library when the key permits, the
  // curated premades otherwise; absent entirely when TTS is off.
  const voice = ttsConfigured() ? await availableVoices() : null;
  return NextResponse.json({
    tiers: tiers.success ? tiers.data : null,
    suggestion_affordance: contract?.suggestion_affordance ?? "on_request_only",
    menus: TIER_MENUS,
    ...(voice
      ? {
          voices: voice.voices,
          voice_source: voice.source,
          voice_id:
            (campaign.voiceSettings as { voice_id?: string } | null)?.voice_id ??
            env.ELEVENLABS_VOICE_ID,
        }
      : {}),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await params;
  const db = getDb();

  const body = SettingsPatch.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      {
        error:
          "only tier menus, suggestion_affordance, and voice_id are writable (M4 owns the rest)",
      },
      { status: 400 },
    );
  }
  const patch = body.data;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty patch" }, { status: 400 });
  }

  // Ownership BEFORE voice validation (audit): a non-owner must see 404 —
  // never trigger the upstream voices fetch, never learn from the 422/404
  // split whether a voice id exists. The transaction re-checks under lock.
  const [owned] = await db
    .select({ playerId: campaigns.playerId })
    .from(campaigns)
    .where(eq(campaigns.id, id));
  if (!owned || owned.playerId !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Voice validation happens OUTSIDE the row lock (it may call ElevenLabs):
  // the id must come from the available set — never an arbitrary string.
  if (patch.voice_id) {
    if (!ttsConfigured()) {
      return NextResponse.json({ error: "voice not configured — cannot apply" }, { status: 422 });
    }
    const { voices } = await availableVoices();
    if (!voices.some((v) => v.voice_id === patch.voice_id)) {
      return NextResponse.json({ error: "unknown voice — cannot apply" }, { status: 422 });
    }
  }

  // Row lock: the log append and the two jsonb writes are read-modify-write.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${campaigns} WHERE ${campaigns.id} = ${id} FOR UPDATE`);
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, id));
    if (!campaign || campaign.playerId !== user.id) return { status: 404 as const };

    const now = new Date().toISOString();
    const log = (
      Array.isArray(campaign.settingsLog) ? campaign.settingsLog : []
    ) as SettingsLogEntry[];
    const changes: SettingsLogEntry[] = [];

    const tiers = TierSelection.safeParse(campaign.tierModels);
    const nextTiers = tiers.success ? { ...tiers.data } : null;
    // A requested write that CANNOT apply answers loudly, never a silent
    // 200-with-nothing (C5 audit #1/#2 — the pillar is "never promise what
    // the system cannot do").
    if ((patch.narration || patch.judgment || patch.probe) && !nextTiers) {
      return { status: 422 as const, error: "tier selection unreadable — cannot apply" };
    }
    let narrationChanged = false;
    for (const tier of ["narration", "judgment", "probe"] as const) {
      const to = patch[tier];
      if (!to || !nextTiers) continue;
      if (nextTiers[tier] === to) continue;
      changes.push({ at: now, field: `tier.${tier}`, from: nextTiers[tier], to });
      if (tier === "narration") narrationChanged = true;
      // The menus share a widened string union once mutated per-key; zod above
      // guarantees per-tier membership, so the assignment is safe.
      (nextTiers as Record<string, string>)[tier] = to;
    }

    const contract = PremiseContract.safeParse(campaign.premiseContract);
    if (patch.suggestion_affordance && !contract.success) {
      return { status: 422 as const, error: "premise contract unreadable — cannot apply" };
    }
    let nextContract = campaign.premiseContract as Record<string, unknown> | null;
    if (patch.suggestion_affordance && contract.success) {
      if (contract.data.suggestion_affordance !== patch.suggestion_affordance) {
        changes.push({
          at: now,
          field: "suggestion_affordance",
          from: contract.data.suggestion_affordance,
          to: patch.suggestion_affordance,
        });
        nextContract = {
          ...contract.data,
          suggestion_affordance: patch.suggestion_affordance,
        };
      }
    }

    // §9.5 voice preference: a jsonb beside tierModels, never the contract.
    let nextVoice: { voice_id: string } | null = null;
    if (patch.voice_id) {
      const currentVoice =
        (campaign.voiceSettings as { voice_id?: string } | null)?.voice_id ??
        env.ELEVENLABS_VOICE_ID;
      if (currentVoice !== patch.voice_id) {
        changes.push({ at: now, field: "voice_id", from: currentVoice, to: patch.voice_id });
        nextVoice = { voice_id: patch.voice_id };
      }
    }

    if (changes.length === 0) return { status: 200 as const, changes, narrationChanged: false };

    await tx
      .update(campaigns)
      .set({
        ...(nextTiers ? { tierModels: nextTiers } : {}),
        ...(nextContract ? { premiseContract: nextContract } : {}),
        ...(nextVoice ? { voiceSettings: nextVoice } : {}),
        settingsLog: [...log, ...changes],
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, id));
    return { status: 200 as const, changes, narrationChanged };
  });

  if (result.status === 404) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (result.status === 422) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({
    ok: true,
    changes: result.changes,
    ...(result.narrationChanged
      ? {
          note: "studio handoff: the next turn rebuilds the prompt cache cold; the voice may shift",
        }
      : {}),
  });
}
