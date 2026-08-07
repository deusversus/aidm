import type { SeedMentionFinding, SeedVerdict } from "@/lib/types/direction";
import { describe, expect, it, vi } from "vitest";
import { clampAdjudication, clampMentions } from "../adjudication";

/**
 * The batched adjudication's bounds discipline (§7.6, C1 clamp pattern): the
 * strict-output grammar carries types and STRIPS ranges — and, measured at
 * M3R4 R-1, demotes enum vocabulary to description text too — so every limit on
 * SeedVerdict is applied here. The rule under test is that the BATCH always
 * survives: a malformed verdict costs itself and nothing else.
 */

const verdict = (over: Partial<SeedVerdict>): SeedVerdict => ({
  seed_ref: 0,
  verdict: "mention",
  confidence: 0.9,
  evidence: "the debt is named aloud",
  ...over,
});

describe("clampAdjudication", () => {
  it("keeps in-range verdicts untouched", () => {
    const kept = clampAdjudication([verdict({ seed_ref: 0 }), verdict({ seed_ref: 2 })], 3);
    expect(kept.map((v) => v.seed_ref)).toEqual([0, 2]);
  });

  it("drops out-of-range refs and keeps the rest of the batch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampAdjudication(
      [verdict({ seed_ref: 7 }), verdict({ seed_ref: -1 }), verdict({ seed_ref: 1 })],
      3,
    );
    expect(kept.map((v) => v.seed_ref)).toEqual([1]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the FIRST verdict per seed — a second opinion never overwrites", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampAdjudication(
      [verdict({ seed_ref: 1, verdict: "payoff" }), verdict({ seed_ref: 1, verdict: "conflict" })],
      3,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.verdict).toBe("payoff");
    warn.mockRestore();
  });

  it("pins confidence into [0,1] rather than failing the parse", () => {
    const kept = clampAdjudication(
      [verdict({ seed_ref: 0, confidence: 1.4 }), verdict({ seed_ref: 1, confidence: -0.2 })],
      2,
    );
    expect(kept[0]?.confidence).toBe(1);
    expect(kept[1]?.confidence).toBe(0);
  });

  it("caps the batch at one verdict per rendered seed", () => {
    const kept = clampAdjudication(
      [verdict({ seed_ref: 0 }), verdict({ seed_ref: 1 }), verdict({ seed_ref: 2 })],
      2,
    );
    expect(kept).toHaveLength(2);
  });

  it("an empty emit is not an error", () => {
    expect(clampAdjudication([], 4)).toEqual([]);
  });
});

/**
 * The verdict-word clamp (M3R4 R-1). Enum vocabulary reaches the model as
 * DESCRIPTION text, not grammar, and ADJUDICATOR_SYSTEM spells the verdicts as
 * prose capitals — so the model answered "MENTION" and 13 of 18 adjudication
 * calls in the N=50 soak died on parse, each taking its whole batch with it.
 * Case is not a judgment error and must never cost a batch.
 */
describe("clampAdjudication — verdict normalization", () => {
  it("takes the prompt's own UPPERCASE spelling as the verdict it plainly is", () => {
    const kept = clampAdjudication(
      [
        verdict({ seed_ref: 0, verdict: "MENTION" }),
        verdict({ seed_ref: 1, verdict: "PAYOFF" }),
        verdict({ seed_ref: 2, verdict: "CONFLICT" }),
        verdict({ seed_ref: 3, verdict: "EXTEND" }),
        verdict({ seed_ref: 4, verdict: "NONE" }),
      ],
      5,
    );
    expect(kept.map((v) => v.verdict)).toEqual(["mention", "payoff", "conflict", "extend", "none"]);
  });

  it("normalizes mixed case and stray whitespace", () => {
    const kept = clampAdjudication(
      [verdict({ seed_ref: 0, verdict: " Payoff " }), verdict({ seed_ref: 1, verdict: "nOnE" })],
      2,
    );
    expect(kept.map((v) => v.verdict)).toEqual(["payoff", "none"]);
  });

  it("an unrecognized verdict becomes `none` — the seed is kept, nothing is done to it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampAdjudication(
      [
        verdict({ seed_ref: 0, verdict: "resolve" }),
        verdict({ seed_ref: 1, verdict: "" }),
        verdict({ seed_ref: 2, verdict: "MENTION" }),
      ],
      3,
    );
    expect(kept.map((v) => v.verdict)).toEqual(["none", "none", "mention"]);
    // The batch survives whole — the soak's failure mode was the opposite.
    expect(kept).toHaveLength(3);
    // …but the no-op is LOUD. A model systematically answering "resolve" is
    // indistinguishable from a model that found nothing unless the raw word
    // and the seed it was meant for reach the log.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("out-of-vocabulary"));
    const line = warn.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain('seed 0: "resolve"');
    expect(line).toContain("seed 1");
    expect(line).not.toContain("seed 2");
    warn.mockRestore();
  });

  it("a mere case fix is not worth a warn — only out-of-vocabulary words are", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clampAdjudication([verdict({ seed_ref: 0, verdict: " PAYOFF " })], 1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The mention question's own clamp (M3R4 R-2). Same law as the verdicts': the
 * batch always survives, the answer word normalizes engine-side, and an answer
 * the vocabulary does not hold reads as NO — the finding that does nothing —
 * loudly, so a model answering some fourth word is not mistaken for a story
 * that surfaced nothing.
 */
const finding = (over: Partial<SeedMentionFinding>): SeedMentionFinding => ({
  seed_ref: 0,
  surfaced: "yes",
  turn: 12,
  confidence: 0.9,
  evidence: "he says the name of the ship out loud",
  ...over,
});

/** The turns this batch actually printed — the citation vocabulary. */
const SHOWN = new Set([10, 11, 12]);

describe("clampMentions", () => {
  it("normalizes the answer word, case and whitespace included", () => {
    const kept = clampMentions(
      [
        finding({ seed_ref: 0, surfaced: "YES" }),
        finding({ seed_ref: 1, surfaced: " no " }),
        finding({ seed_ref: 2, surfaced: "Yes" }),
      ],
      3,
      SHOWN,
    );
    expect(kept.map((m) => m.surfaced)).toEqual([true, false, true]);
  });

  it("an unrecognized answer reads as NO, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0, surfaced: "probably" })], 1, SHOWN);
    expect(kept[0]?.surfaced).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("out-of-vocabulary"));
    expect(warn.mock.calls.at(-1)?.[0]).toContain('seed 0: "probably"');
    warn.mockRestore();
  });

  it("drops out-of-range and duplicate refs, keeping the first finding per seed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions(
      [
        finding({ seed_ref: 9 }),
        finding({ seed_ref: -1 }),
        finding({ seed_ref: 1, surfaced: "yes" }),
        finding({ seed_ref: 1, surfaced: "no" }),
      ],
      3,
      SHOWN,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ seed_ref: 1, surfaced: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("pins confidence into [0,1] and never fails the batch", () => {
    const kept = clampMentions(
      [finding({ seed_ref: 0, confidence: 3 }), finding({ seed_ref: 1, confidence: -1 })],
      2,
      SHOWN,
    );
    expect(kept.map((m) => m.confidence)).toEqual([1, 0]);
  });

  it("an empty emit is not an error — most cycles surface nothing", () => {
    expect(clampMentions([], 4, SHOWN)).toEqual([]);
  });
});

/**
 * The citation rule (M3R4 R-2 audit). The organic sweep proposes a seed by
 * COSINE; a "yes" that quotes nothing, or that points at a scene this batch
 * never printed, is the judge agreeing with the proposal rather than reading
 * the page — which is exactly the confirmation loop §7.6's two-path design
 * exists to break. The prompt says so in words; this is the half that enforces
 * it, and it is loud, because a systematically uncited judge must not look like
 * a story that surfaced nothing.
 */
describe("clampMentions — an uncited yes is a no", () => {
  it("a yes with no quoted phrase is read as no, and named", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0, evidence: "   " })], 1, SHOWN);
    expect(kept[0]?.surfaced).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNCITED"));
    expect(warn.mock.calls.at(-1)?.[0]).toContain("no quoted phrase");
    warn.mockRestore();
  });

  it("a yes citing a turn the batch never showed is read as no", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0, turn: 4 })], 1, SHOWN);
    expect(kept[0]?.surfaced).toBe(false);
    expect(warn.mock.calls.at(-1)?.[0]).toContain("turn 4 is not in this batch's evidence");
    warn.mockRestore();
  });

  it("a properly cited yes is untouched — the rule costs an honest answer nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0, turn: 11 })], 1, SHOWN);
    expect(kept[0]?.surfaced).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a NO needs no citation — turn 0 is the schema's own 'nothing surfaced'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0, surfaced: "no", turn: 0 })], 1, SHOWN);
    expect(kept[0]?.surfaced).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an empty evidence set cites nothing — every yes reads as no", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = clampMentions([finding({ seed_ref: 0 })], 1, new Set());
    expect(kept[0]?.surfaced).toBe(false);
    warn.mockRestore();
  });
});
