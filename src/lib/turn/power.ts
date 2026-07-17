/**
 * Power tiers, the differential floor, and the Module-12 scale machinery
 * (blueprint §5.1, §11-carried; v3 scale_selector.py + _turn_pipeline.py
 * transcribed). Tier numbering is v3's: T10 weakest (ordinary human) → T1/T0
 * strongest (boundless). A LOWER number is MORE powerful.
 */

/** v3's tier bands (scale_selector SCALE_COMPATIBILITY keys). */
export type TierBand =
  | "human" // T11-10
  | "athletic" // T9
  | "superhuman" // T8-7
  | "city" // T6
  | "planetary" // T5
  | "cosmic" // T4-2
  | "boundless"; // T1-0

export function tierBand(tier: number): TierBand {
  if (tier >= 10) return "human";
  if (tier === 9) return "athletic";
  if (tier >= 7) return "superhuman";
  if (tier === 6) return "city";
  if (tier === 5) return "planetary";
  if (tier >= 2) return "cosmic";
  return "boundless";
}

/**
 * The character's effective tier (SV3, §8): the SZ-chosen contract tier
 * rules; the world's baseline is the default for tier-less contracts
 * (pre-SV3 campaigns, or the player waved the beat off). A future
 * character sheet owns LIVE progression; this is the starting contract.
 */
export function characterTierFor(
  pcPowerTier: string | undefined,
  worldBaselineTier: number,
): number {
  if (!pcPowerTier) return worldBaselineTier;
  const n = Number.parseInt(pcPowerTier.slice(1), 10);
  return Number.isNaN(n) ? worldBaselineTier : n;
}

/**
 * Character tiers above world baseline (positive = character stronger,
 * since lower tier number = more powerful).
 */
export function powerDifferential(characterTier: number, worldBaselineTier: number): number {
  return worldBaselineTier - characterTier;
}

/** §5.1: ≥3 tiers above baseline ⇒ routine power use is DC-trivial, no cost. */
export const OP_MODE_DIFFERENTIAL = 3;

export function opModeActive(characterTier: number, worldBaselineTier: number): boolean {
  return powerDifferential(characterTier, worldBaselineTier) >= OP_MODE_DIFFERENTIAL;
}

/**
 * The power context injected into the outcome judgment (v3
 * _turn_pipeline.py L318-328, carried). Empty string when no tiers known.
 */
export function powerContext(characterTier?: number, worldBaselineTier?: number): string {
  if (characterTier === undefined || worldBaselineTier === undefined) return "";
  const diff = powerDifferential(characterTier, worldBaselineTier);
  const lines = [
    `Character power tier: T${characterTier} (${tierBand(characterTier)}). World baseline: T${worldBaselineTier} (${tierBand(worldBaselineTier)}).`,
  ];
  if (diff >= OP_MODE_DIFFERENTIAL) {
    lines.push(
      `OP MODE ACTIVE: character is ${diff} tiers above world baseline — routine power use is trivial (DC 5, no cost, no consequence).`,
    );
  } else if (diff <= -OP_MODE_DIFFERENTIAL) {
    lines.push(
      `Character is ${-diff} tiers BELOW world baseline — ambitious actions run against real gravity; underdog framing applies.`,
    );
  }
  return lines.join(" ");
}

// ---------------------------------------------------------------------------
// Module 12: narrative scales + compatibility (v3-verbatim)
// ---------------------------------------------------------------------------

export const NARRATIVE_SCALES = [
  "tactical", // HxH style — every move matters
  "ensemble", // team dynamics, role balance
  "spectacle", // DBZ style — visual impact
  "existential", // philosophical weight
  "underdog", // David vs Goliath
  "slice_of_life", // low stakes, character focus
  "horror", // atmosphere, vulnerability
  "mystery", // information control
  "comedy", // rule of funny
] as const;
export type NarrativeScale = (typeof NARRATIVE_SCALES)[number];

export type ScaleCompatibility = "OK" | "ACCEPTABLE" | "DISCOURAGED" | "FORBIDDEN";

/** v3 SCALE_COMPATIBILITY, transcribed verbatim (scale_selector.py L36-79). */
export const SCALE_COMPATIBILITY: Record<TierBand, Record<NarrativeScale, ScaleCompatibility>> = {
  human: {
    tactical: "OK",
    ensemble: "OK",
    spectacle: "FORBIDDEN",
    existential: "FORBIDDEN",
    underdog: "ACCEPTABLE",
    slice_of_life: "OK",
    horror: "OK",
    mystery: "OK",
    comedy: "OK",
  },
  athletic: {
    tactical: "OK",
    ensemble: "OK",
    spectacle: "DISCOURAGED",
    existential: "FORBIDDEN",
    underdog: "OK",
    slice_of_life: "OK",
    horror: "ACCEPTABLE",
    mystery: "OK",
    comedy: "OK",
  },
  superhuman: {
    tactical: "ACCEPTABLE",
    ensemble: "OK",
    spectacle: "ACCEPTABLE",
    existential: "ACCEPTABLE",
    underdog: "OK",
    slice_of_life: "OK",
    horror: "ACCEPTABLE",
    mystery: "OK",
    comedy: "OK",
  },
  city: {
    tactical: "DISCOURAGED",
    ensemble: "OK",
    spectacle: "OK",
    existential: "ACCEPTABLE",
    underdog: "ACCEPTABLE",
    slice_of_life: "OK",
    horror: "DISCOURAGED",
    mystery: "ACCEPTABLE",
    comedy: "OK",
  },
  planetary: {
    tactical: "FORBIDDEN",
    ensemble: "OK",
    spectacle: "OK",
    existential: "OK",
    underdog: "FORBIDDEN",
    slice_of_life: "ACCEPTABLE",
    horror: "FORBIDDEN",
    mystery: "ACCEPTABLE",
    comedy: "OK",
  },
  cosmic: {
    tactical: "FORBIDDEN",
    ensemble: "ACCEPTABLE",
    spectacle: "OK",
    existential: "OK",
    underdog: "FORBIDDEN",
    slice_of_life: "ACCEPTABLE",
    horror: "FORBIDDEN",
    mystery: "ACCEPTABLE",
    comedy: "ACCEPTABLE",
  },
  boundless: {
    tactical: "FORBIDDEN",
    ensemble: "FORBIDDEN",
    spectacle: "ACCEPTABLE",
    existential: "OK",
    underdog: "FORBIDDEN",
    slice_of_life: "ACCEPTABLE",
    horror: "FORBIDDEN",
    mystery: "FORBIDDEN",
    comedy: "ACCEPTABLE",
  },
};

/**
 * Module-12 imbalance: Effective = (PC raw × context) ÷ threat raw.
 * v3's EXACT math (scale_selector.py L259-314): raw power is the inverted
 * tier number (T10→0 … T1→9, linear — the 1.5/3/10 thresholds were
 * calibrated against this ratio, so an exponential substitute would
 * misband everything), threat at power 0 doubles the character's raw
 * instead of dividing by zero.
 */
export function tierPowerNum(tier: number): number {
  return Math.max(0, 10 - tier);
}

export function rawPowerRatio(characterTier: number, threatTier: number): number {
  const pc = tierPowerNum(characterTier);
  const threat = tierPowerNum(threatTier);
  if (threat === 0) return pc * 2; // v3: vs the powerless, high advantage
  return pc / Math.max(1, threat);
}

export type ImbalanceBand = "balanced" | "moderate" | "significant" | "overwhelming";

export function imbalanceBand(effectiveRatio: number): ImbalanceBand {
  if (effectiveRatio <= 1.5) return "balanced";
  if (effectiveRatio <= 3) return "moderate";
  if (effectiveRatio <= 10) return "significant";
  return "overwhelming";
}

/** v3 thresholds: OP-mode framing >10×; tension shift >3×. */
export function imbalanceFlags(effectiveRatio: number): {
  triggersOpMode: boolean;
  triggersTensionShift: boolean;
} {
  return { triggersOpMode: effectiveRatio > 10, triggersTensionShift: effectiveRatio > 3 };
}

/** The six context-modifier slots (v3 _detect_context_modifiers), 0.1–1.0 each. */
export const CONTEXT_MODIFIER_KINDS = [
  "environmental",
  "secret_id",
  "self_limiter",
  "mentor",
  "political",
  "genre",
] as const;
export type ContextModifierKind = (typeof CONTEXT_MODIFIER_KINDS)[number];
