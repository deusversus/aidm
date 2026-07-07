import type { SuccessLevel } from "@/lib/types/turn";

/**
 * The virtual d20 (blueprint §5.1): dice are CODE, never model output — the
 * roll happens once in Phase A, is checkpointed with the conte, and a
 * Phase-B retry reuses it (same dice; re-rolling on retry feels rigged,
 * §5.7). The judgment call receives the rolled die and sets DC/modifiers;
 * this module owns the arithmetic and the success bands (v3
 * outcome_judge.md, carried).
 */

export type RollType = "normal" | "advantage" | "disadvantage";

export interface D20Roll {
  /** The natural die face (after advantage/disadvantage selection). */
  natural: number;
  rollType: RollType;
  /** Both faces when advantage/disadvantage rolled two. */
  faces: number[];
}

export function rollD20(rollType: RollType = "normal", rng: () => number = Math.random): D20Roll {
  const face = () => 1 + Math.floor(rng() * 20);
  if (rollType === "normal") {
    const f = face();
    return { natural: f, rollType, faces: [f] };
  }
  const a = face();
  const b = face();
  const natural = rollType === "advantage" ? Math.max(a, b) : Math.min(a, b);
  return { natural, rollType, faces: [a, b] };
}

/**
 * v3's success bands (outcome_judge.md), mapped onto the v5 SuccessLevel
 * enum. Natural 20 is a critical regardless of DC; natural 1 is a
 * catastrophic fumble regardless of modifiers (v3: "failure, catastrophic"
 * — v5's enum gives it its own name).
 *
 * | condition            | level             |
 * | natural 1            | critical_failure  |
 * | natural 20           | critical_success  |
 * | total >= DC + 10     | critical_success  |
 * | total >= DC          | success           |
 * | total >= DC - 4      | partial_success   |
 * | total <  DC - 4      | failure           |
 */
export function successBand(natural: number, total: number, dc: number): SuccessLevel {
  if (natural === 1) return "critical_failure";
  if (natural === 20 || total >= dc + 10) return "critical_success";
  if (total >= dc) return "success";
  if (total >= dc - 4) return "partial_success";
  return "failure";
}

/**
 * Parse the judge's modifier strings ("+2 High Ground", "-3 Injured",
 * "+10 Vastly Overpowered") into a summed bonus. Unparseable entries count
 * as zero — a colorful modifier never breaks the math.
 */
export function sumModifiers(modifiers: string[]): number {
  let sum = 0;
  for (const m of modifiers) {
    const match = /^\s*([+-]\d+)/.exec(m);
    if (match?.[1]) sum += Number.parseInt(match[1], 10);
  }
  return sum;
}
