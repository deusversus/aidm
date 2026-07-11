import { approxTokens } from "@/lib/blocks/tokens";
import { loadGrounding } from "@/lib/rules/grounding";
import type { ArcOverride } from "@/lib/types/arc";
import type { AxisName } from "@/lib/types/grounding";
import { type PencilMark, activeMarks } from "@/lib/types/marks";

/**
 * Settei Amendments (§4.4b): the transient correction channel, rendered
 * into the conte (Block 4) — costs nothing in cache terms because Block 4
 * is dynamic anyway. This is why corrections never wait for a Settei
 * rebuild and never thrash Block 1. Deterministic assembly.
 *
 * Corrective punch-through (§12, M2-C6): a retake that persists without the
 * gauge closing escalates — stronger phrasing, its extreme exemplar quoted
 * inline, positioned FIRST. Bounded: at most ONE escalated axis per render.
 */

export const AMENDMENTS_TOKEN_MAX = 250;
/**
 * The escalated ceiling (M2-C6): an escalated retake carries a short inline
 * exemplar quote, which §4.4b's prose-only ≤250 never budgeted for. Raised
 * here, visibly, and only claimed when an escalation is actually present —
 * the ordinary correction channel still holds to AMENDMENTS_TOKEN_MAX.
 */
export const AMENDMENTS_ESCALATED_TOKEN_MAX = 350;
/** A retake persisting this many turns without the gauge closing escalates. */
export const PUNCH_THROUGH_TURNS = 3;
/**
 * "Still outside the drift band" for punch-through = |active − observed| ≥ this.
 * Mirrors sakkan.ts DRIFT_THRESHOLD (§4.5); duplicated locally so the
 * lightweight renderer never imports the db-touching Sakkan module — must move
 * in lockstep with it.
 */
const PUNCH_THROUGH_BAND = 2;

/** A Sakkan corrective note (retake) — producer lands C8; the contract lives here. */
export interface SakkanNote {
  axis: AxisName;
  active: number;
  observed: number;
  /** The turn the retake first fired (§4.5); its age drives punch-through. */
  since_turn: number;
}

export interface AmendmentsInput {
  arcOverride?: ArcOverride | null;
  sakkanNotes: SakkanNote[];
  /** Marks newer than the last Settei build (reset at the §9.4 session-open rebuild). */
  freshMarks: PencilMark[];
  /**
   * The turn being rendered — enables the punch-through persistence math
   * (§12). Absent → no note can be aged, so escalation never fires.
   */
  currentTurn?: number;
  /**
   * The Sakkan's last sample turn. Escalation requires a RE-MEASUREMENT
   * after the note fired (lastSampleTurn > since_turn) with the note still
   * open — elapsed turns alone are not evidence the correction failed
   * (measured, not vibed; C6 audit #1). Absent → escalation never fires.
   */
  lastSampleTurn?: number;
}

export interface Amendments {
  text: string;
  tokens: number;
  /** Content dropped to hold the budget — surfaced, never silent. */
  trims: string[];
}

interface Escalation {
  note: SakkanNote;
  /** The escalated retake with its inline exemplar quote. */
  line: string;
  /** The same escalated retake without the quote — the budget last resort. */
  lineNoQuote: string;
}

function retakeDirection(note: SakkanNote): "up" | "down" {
  return note.observed > note.active ? "down" : "up";
}

function renderOverride(arcOverride?: ArcOverride | null): string | null {
  if (!arcOverride) return null;
  const shifts: string[] = [];
  for (const [axis, value] of Object.entries(arcOverride.dna ?? {})) {
    shifts.push(`${axis} plays at ${value}/10 for now`);
  }
  for (const [axis, value] of Object.entries(arcOverride.composition ?? {})) {
    shifts.push(`${axis} is ${value} for now`);
  }
  if (shifts.length === 0) return null;
  return `ARC (${arcOverride.arc_name}): ${shifts.join("; ")}. This holds until: ${arcOverride.transition_signal}.`;
}

// Retakes are force-included at strong advisory weight (§4.4b) and expire when
// the Sakkan reads the axis back in band.
function renderRetake(note: SakkanNote): string {
  const direction = retakeDirection(note);
  return `RETAKE (strong): ${note.axis} is reading ${note.observed}/10 on the page; the premise wants ${note.active}/10. Pull it ${direction} — this note lifts when it reads back in band.`;
}

/** The axis's extreme-band exemplar (band by premise value, as the Settei picks), clipped short. */
function escalationQuote(note: SakkanNote): string | null {
  const band = note.active <= 3 ? "1" : note.active >= 7 ? "9" : null;
  if (!band) return null;
  const { byId, anchors } = loadGrounding();
  const ref = anchors.find((a) => a.axis === note.axis)?.bands[band]?.excerpt_ref;
  const exemplar = ref ? byId.get(ref) : undefined;
  return exemplar ? shortExcerpt(exemplar.text, 200) : null;
}

function shortExcerpt(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

/**
 * The single most-overdue eligible retake (§12): persisted ≥ PUNCH_THROUGH_TURNS
 * and still outside the band. Deterministic tiebreak — longest persistence,
 * then widest gap, then axis name. One escalation per render, or none.
 */
function pickEscalation(input: AmendmentsInput): Escalation | null {
  const now = input.currentTurn;
  if (now === undefined) return null;
  // The re-measurement tether (C6 audit #1): a note still open AFTER a
  // sample that post-dates it is MEASURED failure-to-move; elapsed turns
  // alone are not (SAKKAN_INTERVAL is 8 — pure persistence would escalate
  // five turns before the gauge is even re-read).
  const remeasured = input.lastSampleTurn !== undefined ? input.lastSampleTurn : -1;
  const eligible = input.sakkanNotes.filter(
    (n) =>
      now - n.since_turn >= PUNCH_THROUGH_TURNS &&
      remeasured > n.since_turn &&
      Math.abs(n.active - n.observed) >= PUNCH_THROUGH_BAND,
  );
  eligible.sort((a, b) => {
    if (a.since_turn !== b.since_turn) return a.since_turn - b.since_turn;
    const g = Math.abs(b.active - b.observed) - Math.abs(a.active - a.observed);
    if (g !== 0) return g;
    return a.axis.localeCompare(b.axis);
  });
  const [note] = eligible;
  if (!note) return null;

  const persistence = now - note.since_turn;
  const direction = retakeDirection(note);
  const head = `RETAKE (ESCALATED — off-register ${persistence} scenes): ${note.axis} keeps reading ${note.observed}/10; the premise demands ${note.active}/10 and the standing note has not moved it. Pull it ${direction} decisively this scene — this is the correction, not a nudge.`;
  const quote = escalationQuote(note);
  return {
    note,
    line: quote ? `${head} Write ${note.axis} so it feels like this: "${quote}"` : head,
    lineNoQuote: head,
  };
}

export function renderAmendments(input: AmendmentsInput): Amendments {
  const trims: string[] = [];

  const escalated = pickEscalation(input);
  const overrideLine = renderOverride(input.arcOverride);
  // The escalated axis renders as the escalated line instead of a plain retake,
  // never both.
  const retakeLines = input.sakkanNotes
    .filter((n) => !escalated || n.axis !== escalated.note.axis)
    .map(renderRetake);
  const freshLines = activeMarks(input.freshMarks).map(
    (m) => `Fresh calibration — ${m.topic}: ${m.direction}`,
  );

  const build = (escalatedLine: string | null) => {
    // Escalation leads the block (§12); then override, retakes, fresh marks.
    const lines = [
      ...(escalatedLine ? [escalatedLine] : []),
      ...(overrideLine ? [overrideLine] : []),
      ...retakeLines,
      ...freshLines,
    ];
    return lines.length === 0 ? "" : `## Amendments (this scene)\n\n${lines.join("\n")}`;
  };

  const budget = escalated ? AMENDMENTS_ESCALATED_TOKEN_MAX : AMENDMENTS_TOKEN_MAX;
  let escalatedLine = escalated ? escalated.line : null;
  let text = build(escalatedLine);

  // Trim fresh marks first (they migrate into the Settei at the next
  // session-open rebuild), never the retakes (measured corrections outrank
  // accumulating calibration).
  while (approxTokens(text) > budget && freshLines.length > 0) {
    const dropped = freshLines.pop();
    trims.push(`dropped for budget: ${dropped?.slice(0, 60)}`);
    text = build(escalatedLine);
  }
  // Last resort: if the escalated quote still overflows the raised ceiling, drop
  // the quote but keep the escalated phrasing and its lead position.
  if (escalated && escalatedLine === escalated.line && approxTokens(text) > budget) {
    escalatedLine = escalated.lineNoQuote;
    trims.push("escalated exemplar quote dropped for budget");
    text = build(escalatedLine);
  }

  return { text, tokens: approxTokens(text), trims };
}
