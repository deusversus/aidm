import { getPrompt } from "@/lib/prompts";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";

/**
 * Sakuga mode selector (§7.2.1).
 *
 * v3 empirically derived this priority ladder by watching how narration
 * landed in different special-condition contexts. The ordering is load-
 * bearing: `first_time_power` beats everything; `training_payoff` only
 * fires if nothing earlier matched. v4 preserves the ladder verbatim.
 *
 * Fallback path:
 *   - If no special condition matches AND the outcome is CLIMACTIC AND
 *     the intent is SOCIAL → frozen_moment (interior climactic beat)
 *   - Otherwise CLIMACTIC action falls to choreographic
 *   - All non-climactic turns skip sakuga entirely (returns null)
 */

export type SakugaMode = "choreographic" | "frozen_moment" | "aftermath" | "montage";

interface LadderEntry {
  condition: string;
  mode: SakugaMode;
}

// §7.2.1 — v3 verbatim.
const SAKUGA_PRIORITY: LadderEntry[] = [
  { condition: "first_time_power", mode: "frozen_moment" },
  { condition: "protective_rage", mode: "frozen_moment" },
  { condition: "named_attack", mode: "choreographic" },
  { condition: "underdog_moment", mode: "choreographic" },
  { condition: "power_of_friendship", mode: "choreographic" },
  { condition: "training_payoff", mode: "montage" },
];

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
  /**
   * Prompt-registry id of the fragment that was injected. Exposed so
   * turn.ts can record its fingerprint on the turn row — the fragment
   * is pulled at render-time (not `{{include:}}`'d), so editing
   * `sakuga_choreographic.md` doesn't change Block 4's fingerprint;
   * we need to track it separately.
   */
  promptId: string;
}

/**
 * Decide whether sakuga fires and which sub-mode. Returns null when the
 * beat doesn't warrant sakuga (most turns). The returned fragment is
 * ready to paste into Block 4.
 */
export function selectSakugaMode(
  intent: IntentOutput,
  outcome: OutcomeOutput | undefined,
): SakugaSelection | null {
  // Special-condition priority ladder first — beats climactic-weight
  // fallback when a specific trigger names the treatment.
  for (const entry of SAKUGA_PRIORITY) {
    if (intent.special_conditions.includes(entry.condition)) {
      const promptId = FRAGMENT_ID[entry.mode];
      return {
        mode: entry.mode,
        reason: `special_condition: ${entry.condition}`,
        fragment: getPrompt(promptId).content,
        promptId,
      };
    }
  }

  // Climactic-weight fallback. Non-climactic turns skip sakuga.
  if (!outcome || outcome.narrative_weight !== "CLIMACTIC") {
    return null;
  }

  const mode: SakugaMode = intent.intent === "SOCIAL" ? "frozen_moment" : "choreographic";
  const promptId = FRAGMENT_ID[mode];
  return {
    mode,
    reason: `fallback: CLIMACTIC weight, intent=${intent.intent}`,
    fragment: getPrompt(promptId).content,
    promptId,
  };
}
