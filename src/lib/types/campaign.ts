import { z } from "zod";
import { ArcOverride } from "./arc";
import { Composition, PartialComposition } from "./composition";
import { DNAScales, PartialDNAScales } from "./dna";
import { IPMechanics } from "./profile";

/**
 * Campaign — the working state for a running game.
 *
 * Three-layer model:
 *   1. canonical (on Profile, static)        — how the source IS told
 *   2. active (on Campaign, persistent)      — what the player chose for THIS run
 *   3. arc_override (on Campaign, transient) — Director's per-arc deviations
 *
 * KA and Director read effective state as:
 *   effective_dna         = { ...active_dna, ...arc_override?.dna }
 *   effective_composition = { ...active_composition, ...arc_override?.composition }
 *
 * Hybrid campaigns: `profile_refs` can reference more than one profile. The
 * SZ conductor synthesizes `active_ip` from multiple profiles' mechanics
 * (authored blend, not mechanical union) at campaign creation.
 */

/** The synthesized IP — populated at campaign creation from profile(s) + user intent. */
export const ResolvedIP = IPMechanics.extend({
  /** For single-profile campaigns this is just profile.title; for hybrids, the conductor's authored label. */
  display_title: z.string().min(1),
  /** Human-readable blend description for hybrids. Empty for single-profile campaigns. */
  synthesis_summary: z.string().default(""),
});

export type ResolvedIP = z.infer<typeof ResolvedIP>;

export const Campaign = z.object({
  id: z.string().uuid(),

  /** One entry = strict adaptation. Multiple = hybrid. */
  profile_refs: z.array(z.string().min(1)).min(1),

  /** Synthesized world/rules — not a union of profiles, an authored blend. */
  active_ip: ResolvedIP,

  /** Working tonal treatment. Defaults from profile(s) at creation; user can dial any axis. */
  active_dna: DNAScales,

  /** Working narrative framing. Defaults from profile(s) at creation; can diverge per arc. */
  active_composition: Composition,

  /** Director's transient per-arc shift, if any. Clears on transition_signal firing. */
  arc_override: ArcOverride.optional(),

  /** For hybrids: conductor's rationale for how the blend resolved (audit trail). */
  hybrid_synthesis_notes: z.string().optional(),
});

export type Campaign = z.infer<typeof Campaign>;

/**
 * CampaignCreationRequest — the Session Zero input shape that spawns a Campaign.
 *
 * User can request a strict single-profile campaign, a hybrid blending multiple
 * profiles, or a custom run that diverges from the profile's canonical tone
 * even before Session Zero begins. The SZ conductor consumes this + the profile
 * canonical data to produce the campaign's active_* fields.
 */
export const CampaignCreationRequest = z.object({
  profile_refs: z.array(z.string().min(1)).min(1),
  /** Freeform player intent — "HxH with Hellsing's tone", "Pokemon but grimdark", etc. */
  user_intent: z.string().default(""),
  /** Optional up-front overrides. Any axis the player sets replaces the default blend. */
  dna_overrides: PartialDNAScales.optional(),
  composition_overrides: PartialComposition.optional(),
});

export type CampaignCreationRequest = z.infer<typeof CampaignCreationRequest>;
