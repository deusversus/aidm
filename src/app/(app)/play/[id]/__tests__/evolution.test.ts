import { describe, expect, it } from "vitest";
import {
  type EvolutionProposalView,
  evolutionEyebrow,
  shiftLine,
  showableProposal,
} from "../evolution";

/**
 * The §7.1 ratification card's pure rules (M3 C4) — the component logic that
 * decides whether the question is showable at all, and how a shift reads.
 * Kept out of the DOM per the M2R7 retake.ts precedent; the C10 browser pass
 * covers the rendered card via its data-evolution attributes.
 */

const proposal = (over: Partial<EvolutionProposalView> = {}): EvolutionProposalView => ({
  season_name: "Season 1",
  proposed_at_turn: 46,
  director_case: "This story has been drifting somewhere quieter and crueler. I think it's better.",
  axes: [{ axis: "darkness", from: 7, to: 10 }],
  ...over,
});

describe("showableProposal", () => {
  it("shows a proposal that carries both a case and a real shift", () => {
    expect(showableProposal(proposal())).toBe(true);
  });

  it("hides nothing at all", () => {
    expect(showableProposal(null)).toBe(false);
  });

  it("hides an empty case — a card that argues nothing is not a question", () => {
    expect(showableProposal(proposal({ director_case: "  " }))).toBe(false);
  });

  it("hides a proposal whose axes do not move", () => {
    expect(showableProposal(proposal({ axes: [{ axis: "darkness", from: 7, to: 7 }] }))).toBe(
      false,
    );
    expect(showableProposal(proposal({ axes: [] }))).toBe(false);
  });
});

describe("shiftLine", () => {
  it("reads the axis as prose and the dial honestly — the player agrees to a specific change", () => {
    expect(shiftLine({ axis: "moral_complexity", from: 8, to: 5 })).toBe("moral complexity 8 → 5");
  });

  it("keeps fractional readings to one decimal", () => {
    expect(shiftLine({ axis: "darkness", from: 7, to: 9.5 })).toBe("darkness 7 → 9.5");
  });
});

describe("evolutionEyebrow", () => {
  it("names the season when the row named one", () => {
    expect(evolutionEyebrow(proposal())).toBe("Season 1 — the season's turn");
  });

  it("degrades to the bare register when it did not", () => {
    expect(evolutionEyebrow(proposal({ season_name: "   " }))).toBe("the season's turn");
    const { season_name: _drop, ...noName } = proposal();
    expect(evolutionEyebrow(noName)).toBe("the season's turn");
  });
});
