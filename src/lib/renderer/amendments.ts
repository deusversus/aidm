import { approxTokens } from "@/lib/blocks/tokens";
import type { ArcOverride } from "@/lib/types/arc";
import type { AxisName } from "@/lib/types/grounding";
import { type PencilMark, activeMarks } from "@/lib/types/marks";

/**
 * Settei Amendments (§4.4b): the transient correction channel, rendered
 * into the conte (Block 4) — costs nothing in cache terms because Block 4
 * is dynamic anyway. This is why corrections never wait for a Settei
 * rebuild and never thrash Block 1. ≤250 tokens; deterministic assembly.
 */

export const AMENDMENTS_TOKEN_MAX = 250;

/** A Sakkan corrective note (retake) — producer lands C8; the contract lives here. */
export interface SakkanNote {
  axis: AxisName;
  active: number;
  observed: number;
}

export interface AmendmentsInput {
  arcOverride?: ArcOverride | null;
  sakkanNotes: SakkanNote[];
  /** Marks newer than the last Settei build (reset at the §9.4 session-open rebuild). */
  freshMarks: PencilMark[];
}

export interface Amendments {
  text: string;
  tokens: number;
  /** Content dropped to hold the budget — surfaced, never silent. */
  trims: string[];
}

export function renderAmendments(input: AmendmentsInput): Amendments {
  const lines: string[] = [];
  const trims: string[] = [];

  if (input.arcOverride) {
    const o = input.arcOverride;
    const shifts: string[] = [];
    for (const [axis, value] of Object.entries(o.dna ?? {})) {
      shifts.push(`${axis} plays at ${value}/10 for now`);
    }
    for (const [axis, value] of Object.entries(o.composition ?? {})) {
      shifts.push(`${axis} is ${value} for now`);
    }
    if (shifts.length > 0) {
      lines.push(
        `ARC (${o.arc_name}): ${shifts.join("; ")}. This holds until: ${o.transition_signal}.`,
      );
    }
  }

  // Retakes are force-included at strong advisory weight (§4.4b) and expire
  // when the Sakkan reads the axis back in band.
  for (const note of input.sakkanNotes) {
    const direction = note.observed > note.active ? "down" : "up";
    lines.push(
      `RETAKE (strong): ${note.axis} is reading ${note.observed}/10 on the page; the premise wants ${note.active}/10. Pull it ${direction} — this note lifts when it reads back in band.`,
    );
  }

  for (const mark of activeMarks(input.freshMarks)) {
    lines.push(`Fresh calibration — ${mark.topic}: ${mark.direction}`);
  }

  let kept = [...lines];
  let text = kept.length === 0 ? "" : `## Amendments (this scene)\n\n${kept.join("\n")}`;
  // Trim fresh marks first (they migrate into the Settei at the next
  // session-open rebuild), never the retakes (measured corrections outrank
  // accumulating calibration).
  while (approxTokens(text) > AMENDMENTS_TOKEN_MAX && kept.some((l) => l.startsWith("Fresh"))) {
    const idx = kept.map((l) => l.startsWith("Fresh")).lastIndexOf(true);
    trims.push(`dropped for budget: ${kept[idx]?.slice(0, 60)}`);
    kept = kept.filter((_, i) => i !== idx);
    text = kept.length === 0 ? "" : `## Amendments (this scene)\n\n${kept.join("\n")}`;
  }

  return { text, tokens: approxTokens(text), trims };
}
