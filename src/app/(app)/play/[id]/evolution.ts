/**
 * The season-boundary ratification card (§7.1, M3 C4): the pure rules behind
 * the surface — what the card is allowed to show, and how a proposed shift
 * reads in a sentence. Kept out of the client component so they unit-test
 * without a DOM harness (the M2R7 retake.ts precedent).
 *
 * The card is a QUESTION, not the steering notice's dismissible line: it has no
 * dismiss, it survives every mount, and only the player's word closes it.
 */

export interface EvolutionAxisShift {
  axis: string;
  from: number;
  to: number;
}

export interface EvolutionProposalView {
  season_name?: string;
  proposed_at_turn?: number;
  director_case: string;
  axes: EvolutionAxisShift[];
}

/** Integers bare, fractions to one decimal — the same reading as the notice line. */
function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Axis keys are snake_case in the contract and prose on the page. */
function humanAxis(axis: string): string {
  return axis.replace(/_/g, " ");
}

/**
 * One shift, as the player reads it: the dial is named honestly (they are
 * agreeing to a specific change) but stays a single quiet line — the CASE above
 * it is where the argument lives.
 */
export function shiftLine(shift: EvolutionAxisShift): string {
  return `${humanAxis(shift.axis)} ${fmtScore(shift.from)} → ${fmtScore(shift.to)}`;
}

/**
 * A proposal is showable only when it carries both halves: the Director's case
 * (shown verbatim — an empty one would render a card that argues nothing) and
 * at least one shift that actually moves. A malformed proposal degrades to no
 * card rather than to a question the player cannot answer meaningfully.
 */
export function showableProposal(proposal: EvolutionProposalView | null): boolean {
  if (!proposal) return false;
  if (!proposal.director_case.trim()) return false;
  return proposal.axes.some((a) => a.to !== a.from);
}

/** The card's eyebrow: the season that reached its turn, when the row named one. */
export function evolutionEyebrow(proposal: EvolutionProposalView): string {
  const season = proposal.season_name?.trim();
  return season ? `${season} — the season's turn` : "the season's turn";
}
