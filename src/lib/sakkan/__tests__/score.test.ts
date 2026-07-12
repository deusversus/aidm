import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { describe, expect, it, vi } from "vitest";
import { MAX_SCORED_AXES, type ScoreOptions, scoreAxes } from "../score";

// M2-C6 closed real coverage at all 24 axes, so the gap-rule refusal can no
// longer be provoked with a real axis — the guard still protects any FUTURE
// axis added without grounding; this mock recreates that future.
vi.mock("@/lib/types/grounding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/types/grounding")>();
  return {
    ...actual,
    COVERED_AXES: actual.COVERED_AXES.filter((a) => a !== "avant_garde"),
  };
});

// The scorer's ONLY model surface. Mocking callJudgment lets us inspect the
// prompt the Sakkan constructs WITHOUT a live call — the blind protocol is
// asserted structurally, on what actually reaches the model.
vi.mock("@/lib/llm/calls", () => ({ callJudgment: vi.fn() }));
import { callJudgment } from "@/lib/llm/calls";
const mockJudgment = vi.mocked(callJudgment);

// Type-level guarantee (blind protocol, §4.5): ScoreOptions exposes NO channel
// for the values the story is aiming for — only the prose, the axis list, and
// trace/telemetry ids. Add a `target`/`active`/`wanted`/`premise` field and
// keyof ScoreOptions widens, breaking this line at compile time (pnpm typecheck).
type AssertExact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const scoreOptionsCarryNoIntent: AssertExact<
  keyof ScoreOptions,
  "sample" | "axes" | "name" | "campaignId" | "turnNumber"
> = true;

// The vocabulary that would leak what the story is REACHING for, past the
// blind anchors. None of it may appear in the constructed system+prompt.
const INTENT_LEAK_TOKENS = ["target", "active value", "premise demands", "contract"];

describe("scoreAxes gap-rule + cap refusals (pre-LLM, no API call)", () => {
  it("throws on an uncovered axis before any model call", async () => {
    await expect(
      scoreAxes(DEV_TIER_SELECTION, {
        sample: "some prose",
        axes: ["avant_garde"],
      }),
    ).rejects.toThrow(/uncovered axes avant_garde/);
    expect(mockJudgment).not.toHaveBeenCalled();
  });

  it("throws when more than MAX_SCORED_AXES are requested (no silent truncation)", async () => {
    // The anchored block is per-axis; a whole-charter score would blow the budget.
    const tooMany = [
      "pacing",
      "darkness",
      "comedy",
      "emotional_register",
      "intimacy",
      "interiority",
      "register",
      "cruelty",
      "epistemics",
    ] as const;
    expect(tooMany.length).toBeGreaterThan(MAX_SCORED_AXES);
    await expect(
      scoreAxes(DEV_TIER_SELECTION, { sample: "some prose", axes: [...tooMany] }),
    ).rejects.toThrow(/exceeds MAX_SCORED_AXES/);
    expect(mockJudgment).not.toHaveBeenCalled();
  });
});

describe("scoreAxes blind protocol (structural, on the constructed call)", () => {
  // darkness is a clean-excerpt axis (its witnesses/excerpts contain none of the
  // leak tokens), so the assertion isolates OUR scaffolding from incidental
  // exemplar prose — cruelty/fidelity excerpts, for instance, use "contract"
  // narratively, which is legitimate scene prose, not intent leakage.
  const CLEAN_AXIS = "darkness" as const;

  it("the ScoreOptions key set carries no intent channel (type-level pin)", () => {
    expect(scoreOptionsCarryNoIntent).toBe(true);
  });

  it("neither system nor prompt leaks the story's intended values", async () => {
    mockJudgment.mockResolvedValueOnce({
      scores: [{ axis: CLEAN_AXIS, score: 5, confidence: 0.8, evidence_span: "the neon guttered" }],
    });
    await scoreAxes(DEV_TIER_SELECTION, {
      sample: "The neon hummed over wet asphalt while she counted her breaths.",
      axes: [CLEAN_AXIS],
    });
    const opts = mockJudgment.mock.calls[0]?.[1];
    const surface = `${opts?.system ?? ""}\n${opts?.prompt ?? ""}`.toLowerCase();
    for (const token of INTENT_LEAK_TOKENS) {
      expect(surface).not.toContain(token);
    }
    // The blindness language survived the rewording.
    expect(surface).toContain("text alone");
  });

  it("the anchored block reaches the prompt: witnesses, band labels, and excerpts", async () => {
    mockJudgment.mockResolvedValueOnce({
      scores: [{ axis: CLEAN_AXIS, score: 5, confidence: 0.8, evidence_span: "the neon guttered" }],
    });
    await scoreAxes(DEV_TIER_SELECTION, {
      sample: "The neon hummed over wet asphalt.",
      axes: [CLEAN_AXIS],
    });
    const prompt = mockJudgment.mock.calls[0]?.[1]?.prompt ?? "";
    // Band witnesses (first two shows of bands 1/5/9).
    expect(prompt).toContain("Laid-Back Camp");
    expect(prompt).toContain("Berserk");
    expect(prompt).toContain("feels like:");
    // The two extreme excerpts, clipped in-register.
    expect(prompt).toContain("a 1 reads like:");
    expect(prompt).toContain("a 9 reads like:");
    expect(prompt).toContain("The lake at dawn was the color of milk tea");
    // The clip lands at a word boundary with an ellipsis, not mid-word.
    expect(prompt).toContain("…");
  });
});
