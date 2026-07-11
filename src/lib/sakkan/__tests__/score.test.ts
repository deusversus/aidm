import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { describe, expect, it, vi } from "vitest";
import { scoreAxes } from "../score";

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

describe("scoreAxes gap-rule refusal (pre-LLM, no API call)", () => {
  it("throws on an uncovered axis before any model call", async () => {
    await expect(
      scoreAxes(DEV_TIER_SELECTION, {
        sample: "some prose",
        axes: ["avant_garde"],
      }),
    ).rejects.toThrow(/uncovered axes avant_garde/);
  });
});
