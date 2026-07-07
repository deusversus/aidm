import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { describe, expect, it } from "vitest";
import { scoreAxes } from "../score";

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
