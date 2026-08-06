import type { SeedVerdict } from "@/lib/types/direction";
import { describe, expect, it, vi } from "vitest";
import { clampAdjudication } from "../adjudication";

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
