import type { IntentOutput, OutcomeOutput, SakugaMode } from "@/lib/types/turn";
import { SAKUGA_FRAGMENTS } from "./fragments";

export type { SakugaMode };

/**
 * Sakuga mode selector (blueprint §5.1 — a budget-spend decision, not a
 * combat reflex).
 *
 * v3 empirically derived this priority ladder by watching how narration
 * landed in different special-condition contexts. The ordering is load-
 * bearing: `first_time_power` beats everything; `training_payoff` only
 * fires if nothing earlier matched. v5 preserves the ladder verbatim.
 *
 * Fallback path:
 *   - If no special condition matches AND the outcome is CLIMACTIC AND
 *     the intent is SOCIAL → frozen_moment (interior climactic beat)
 *   - Otherwise CLIMACTIC action falls to choreographic
 *   - All non-climactic turns skip sakuga entirely (returns null)
 */

interface LadderEntry {
  condition: string;
  mode: SakugaMode;
}

// v3 verbatim.
const SAKUGA_PRIORITY: LadderEntry[] = [
  { condition: "first_time_power", mode: "frozen_moment" },
  { condition: "protective_rage", mode: "frozen_moment" },
  { condition: "named_attack", mode: "choreographic" },
  { condition: "underdog_moment", mode: "choreographic" },
  { condition: "power_of_friendship", mode: "choreographic" },
  { condition: "training_payoff", mode: "montage" },
];

// Stable fragment identifiers, preserved from the v4 registry so turn rows
// can fingerprint which fragment text was injected.
const FRAGMENT_ID: Record<SakugaMode, string> = {
  choreographic: "fragments/sakuga_choreographic",
  frozen_moment: "fragments/sakuga_frozen_moment",
  aftermath: "fragments/sakuga_aftermath",
  montage: "fragments/sakuga_montage",
};

export interface SakugaSelection {
  mode: SakugaMode;
  reason: string;
  fragment: string;
  /** Stable id of the injected fragment, recorded on the turn row. */
  promptId: string;
}

/**
 * Decide whether sakuga fires and which sub-mode. Returns null when the
 * beat doesn't warrant sakuga (most turns). The returned fragment is
 * ready to paste into the conte.
 */
export function selectSakugaMode(
  intent: IntentOutput,
  outcome: OutcomeOutput | undefined,
): SakugaSelection | null {
  // Special-condition priority ladder first — beats climactic-weight
  // fallback when a specific trigger names the treatment.
  for (const entry of SAKUGA_PRIORITY) {
    if (intent.special_conditions.includes(entry.condition)) {
      return {
        mode: entry.mode,
        reason: `special_condition: ${entry.condition}`,
        fragment: SAKUGA_FRAGMENTS[entry.mode],
        promptId: FRAGMENT_ID[entry.mode],
      };
    }
  }

  // Climactic-weight fallback. Non-climactic turns skip sakuga.
  if (!outcome || outcome.narrative_weight !== "CLIMACTIC") {
    return null;
  }

  const mode: SakugaMode = intent.intent === "SOCIAL" ? "frozen_moment" : "choreographic";
  return {
    mode,
    reason: `fallback: CLIMACTIC weight, intent=${intent.intent}`,
    fragment: SAKUGA_FRAGMENTS[mode],
    promptId: FRAGMENT_ID[mode],
  };
}
