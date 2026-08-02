import type { SeasonBoundary } from "@/lib/direction/arcs";
import {
  type EvolutionCandidate,
  buildEvolutionProposal,
  evolutionCandidates,
  evolutionNote,
  materialEvidence,
  renderEvolutionReview,
} from "@/lib/direction/evolution";
import { BEBOP_DNA } from "@/lib/renderer/__tests__/fixtures";
import {
  DIRECTOR_CAPS,
  DirectionState,
  EVOLUTION_AXIS_DELTA,
  EVOLUTION_MIN_AXES,
  EVOLUTION_SUSTAINED_SAMPLES,
  type EvolutionProposal,
} from "@/lib/types/direction";
import { describe, expect, it, vi } from "vitest";

/**
 * The §7.1 evidence gate (M3 C4), pure. The load-bearing assertions here are
 * the NEGATIVES: "rare, evidence-gated, confident" means a season that does not
 * clear the bar produces no section, and therefore no card, and therefore never
 * an anxious check-in. Every threshold is pinned to its named constant so a
 * retune has to say so out loud.
 */

/** BEBOP_DNA: darkness 7, cruelty 5, optimism 3, comedy 4. */
const active = BEBOP_DNA;

function state(opts: {
  findings?: Array<{ axis: string; observed: number; wanted: number; at_turn?: number }>;
  drift?: Record<string, number>;
  pending?: boolean;
}): DirectionState {
  const player_driven: Record<string, unknown> = {};
  for (const f of opts.findings ?? []) {
    player_driven[f.axis] = {
      axis: f.axis,
      observed: f.observed,
      wanted: f.wanted,
      evidence: `the player kept pushing ${f.axis}`,
      at_turn: f.at_turn ?? 40,
    };
  }
  const readings: Record<string, unknown> = {};
  for (const [axis, consecutive] of Object.entries(opts.drift ?? {})) {
    readings[axis] = {
      observed: 9,
      confidence: 0.8,
      at_turn: 44,
      consecutive_drift: consecutive,
      evidence: "quoted phrase",
    };
  }
  return DirectionState.parse({
    sakkan: { last_sample_turn: 44, readings, active_notes: [], player_driven },
    ...(opts.pending
      ? {
          evolution_proposal: {
            season_id: "season-1",
            season_name: "Season 1",
            proposed_at_turn: 40,
            director_case: "already asked",
            axes: [{ axis: "darkness", from: 7, to: 9 }],
          },
        }
      : {}),
  });
}

const season: SeasonBoundary = {
  seasonId: "season-1",
  name: "Season 1",
  consumed: 12,
  target: 12,
  reason: "budget_reached",
};

describe("evolutionCandidates (both instruments must agree)", () => {
  it("takes an axis only when a player-driven finding AND sustained drift line up", () => {
    const candidates = evolutionCandidates(
      state({
        findings: [{ axis: "darkness", observed: 10, wanted: 7 }],
        drift: { darkness: EVOLUTION_SUSTAINED_SAMPLES },
      }),
      active,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ axis: "darkness", from: 7, observed: 10, delta: 3 });
  });

  it("drops an axis whose drift is not yet sustained (one sample short)", () => {
    const candidates = evolutionCandidates(
      state({
        findings: [{ axis: "darkness", observed: 10, wanted: 7 }],
        drift: { darkness: EVOLUTION_SUSTAINED_SAMPLES - 1 },
      }),
      active,
    );
    expect(candidates).toEqual([]);
  });

  it("drops a sustained drift the attribution never charged to the player", () => {
    // Narrator wander is the RETAKE's business (§4.5), never a retooling's.
    const candidates = evolutionCandidates(state({ findings: [], drift: { darkness: 9 } }), active);
    expect(candidates).toEqual([]);
  });

  it("drops an axis the DNA schema does not carry (a hand-edited state never amends)", () => {
    const candidates = evolutionCandidates(
      state({
        findings: [{ axis: "not_a_real_axis", observed: 9, wanted: 2 }],
        drift: { not_a_real_axis: 9 },
      }),
      active,
    );
    expect(candidates).toEqual([]);
  });

  it("measures `from` off the ACTIVE contract, not the finding's remembered value", () => {
    // `wanted` on the finding is the EFFECTIVE premise at trip time (active ⊕
    // override). Ratification amends ACTIVE, so that is what the delta must use.
    const candidates = evolutionCandidates(
      state({
        findings: [{ axis: "darkness", observed: 10, wanted: 2 }],
        drift: { darkness: 5 },
      }),
      active,
    );
    expect(candidates[0]?.from).toBe(active.darkness);
    expect(candidates[0]?.delta).toBe(10 - active.darkness);
  });

  it("sorts deepest first — the dossier leads with the axis that moved most", () => {
    const candidates = evolutionCandidates(
      state({
        findings: [
          { axis: "comedy", observed: 5, wanted: 4 },
          { axis: "darkness", observed: 10, wanted: 7 },
        ],
        drift: { comedy: 4, darkness: 4 },
      }),
      active,
    );
    expect(candidates.map((c) => c.axis)).toEqual(["darkness", "comedy"]);
  });
});

describe("materialEvidence (the two branches, pinned to their constants)", () => {
  const candidate = (axis: string, delta: number): EvolutionCandidate => ({
    axis,
    from: 5,
    observed: 5 + delta,
    delta,
    samples: EVOLUTION_SUSTAINED_SAMPLES,
    evidence: "",
    since_turn: 40,
  });

  it("one axis at the depth threshold is material", () => {
    expect(materialEvidence([candidate("darkness", EVOLUTION_AXIS_DELTA)])).toBe(true);
  });

  it("one axis under the depth threshold is NOT — a mood earns no question", () => {
    expect(materialEvidence([candidate("darkness", EVOLUTION_AXIS_DELTA - 1)])).toBe(false);
  });

  it("the breadth branch admits shallower axes once there are enough of them", () => {
    const shallow = Array.from({ length: EVOLUTION_MIN_AXES }, (_, i) =>
      candidate(`axis_${i}`, EVOLUTION_AXIS_DELTA - 1),
    );
    expect(materialEvidence(shallow)).toBe(true);
    expect(materialEvidence(shallow.slice(0, EVOLUTION_MIN_AXES - 1))).toBe(false);
  });

  it("no candidates is never material (the pinned negative)", () => {
    expect(materialEvidence([])).toBe(false);
  });
});

describe("renderEvolutionReview", () => {
  it("names the season, the measured evidence, and that declining costs nothing", () => {
    const candidates = evolutionCandidates(
      state({
        findings: [{ axis: "darkness", observed: 10, wanted: 7, at_turn: 38 }],
        drift: { darkness: 5 },
      }),
      active,
    );
    const section = renderEvolutionReview({ season, candidates });
    expect(section).toContain("## EVOLUTION REVIEW");
    expect(section).toContain("Season 1");
    expect(section).toContain("darkness");
    expect(section).toContain("since turn 38");
    expect(section).toContain("Declining is the ordinary answer");
    // The player reads the case verbatim — the section must say so.
    expect(section).toContain("VERBATIM");
  });
});

describe("buildEvolutionProposal (the C1 bounds law, applied engine-side)", () => {
  const candidates = evolutionCandidates(
    state({
      findings: [
        { axis: "darkness", observed: 10, wanted: 7 },
        { axis: "cruelty", observed: 9, wanted: 5 },
      ],
      drift: { darkness: 5, cruelty: 4 },
    }),
    active,
  );
  const gate = { season, candidates };

  it("stamps from off the evidence and to off the model, at the raising turn", () => {
    const proposal = buildEvolutionProposal(
      {
        director_case: "This story got quieter and crueler. I think it's better.",
        axes: [{ axis: "darkness", to: 10 }],
      },
      gate,
      46,
    );
    expect(proposal).toMatchObject({
      season_id: "season-1",
      proposed_at_turn: 46,
      axes: [{ axis: "darkness", from: 7, to: 10 }],
    });
  });

  it("drops an axis outside the season's evidence — a proposal may only move what was measured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const proposal = buildEvolutionProposal(
      {
        director_case: "case",
        axes: [
          { axis: "comedy", to: 9 },
          { axis: "darkness", to: 10 },
        ],
      },
      gate,
      46,
    );
    expect(proposal?.axes.map((a) => a.axis)).toEqual(["darkness"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clamps out-of-band destinations rather than losing the whole proposal", () => {
    const proposal = buildEvolutionProposal(
      { director_case: "case", axes: [{ axis: "darkness", to: 42 }] },
      gate,
      46,
    );
    expect(proposal?.axes[0]?.to).toBe(10);
  });

  it("caps the axis list at DIRECTOR_CAPS.evolution_axes", () => {
    const wide = evolutionCandidates(
      state({
        findings: [
          { axis: "darkness", observed: 10, wanted: 7 },
          { axis: "cruelty", observed: 9, wanted: 5 },
          { axis: "optimism", observed: 0, wanted: 3 },
          { axis: "comedy", observed: 0, wanted: 4 },
          { axis: "intimacy", observed: 10, wanted: 6 },
        ],
        drift: { darkness: 5, cruelty: 5, optimism: 5, comedy: 5, intimacy: 5 },
      }),
      active,
    );
    const proposal = buildEvolutionProposal(
      {
        director_case: "case",
        axes: wide.map((c) => ({ axis: c.axis, to: c.observed })),
      },
      { season, candidates: wide },
      46,
    );
    expect(proposal?.axes.length).toBe(DIRECTOR_CAPS.evolution_axes);
  });

  it("returns null when nothing actually moves — a card that changes nothing never raises", () => {
    expect(
      buildEvolutionProposal(
        { director_case: "case", axes: [{ axis: "darkness", to: active.darkness }] },
        gate,
        46,
      ),
    ).toBeNull();
  });

  it("returns null on an empty case — the card would argue nothing", () => {
    expect(
      buildEvolutionProposal(
        { director_case: "   ", axes: [{ axis: "darkness", to: 10 }] },
        gate,
        46,
      ),
    ).toBeNull();
  });

  it("returns null when the model emitted nothing", () => {
    expect(buildEvolutionProposal(undefined, gate, 46)).toBeNull();
  });
});

describe("evolutionNote (the bible's source material)", () => {
  it("dates the note and carries the Director's case verbatim, with no dial numbers", () => {
    const proposal: EvolutionProposal = {
      season_id: "season-1",
      season_name: "Season 1",
      proposed_at_turn: 46,
      director_case: "This story has been drifting toward something quieter and crueler.",
      axes: [{ axis: "darkness", from: 7, to: 10 }],
    };
    const note = evolutionNote(proposal);
    expect(note).toContain("Season 1");
    expect(note).toContain("turn 46");
    expect(note).toContain("quieter and crueler");
    // Numbers are for measurement; prose is for pressure (§4.4) — and this row
    // rides every conte as a critical fact.
    expect(note).not.toContain("7");
    expect(note).not.toContain("10");
  });
});

describe("the M2R3 steering notice is a different mechanism (reconciliation pin)", () => {
  it("a pending proposal and a steering notice coexist on one state without collision", () => {
    const parsed = DirectionState.parse({
      steering_notice: { axis: "darkness", observed: 9, set: 7, at_turn: 30 },
      evolution_proposal: {
        season_id: "season-1",
        proposed_at_turn: 46,
        director_case: "case",
        axes: [{ axis: "darkness", from: 7, to: 10 }],
      },
    });
    expect(parsed.steering_notice?.at_turn).toBe(30);
    expect(parsed.evolution_proposal?.proposed_at_turn).toBe(46);
  });
});
