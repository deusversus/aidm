import { COVERED_AXES } from "@/lib/types/grounding";
import { describe, expect, it } from "vitest";
import { loadGrounding } from "../grounding";

describe("grounding library (§4.6–4.7, gap rule)", () => {
  const lib = loadGrounding();

  it("covers all fourteen axes (v0 ten + M1 gap-rule four) with anchors and both extremes", () => {
    expect(COVERED_AXES).toHaveLength(14);
    expect(lib.anchors.length).toBeGreaterThanOrEqual(14);
    expect(lib.exemplars).toHaveLength(28);
  });

  it("every anchor band pins 2–5 witness shows with IP-specific notes", () => {
    for (const anchor of lib.anchors) {
      for (const def of Object.values(anchor.bands)) {
        expect(def.shows.length).toBeGreaterThanOrEqual(2);
        expect(def.shows.length).toBeLessThanOrEqual(5);
        for (const show of def.shows) {
          expect(show.note.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it("extreme bands carry excerpt refs; all refs resolve to matching axis/band", () => {
    for (const anchor of lib.anchors) {
      expect(anchor.bands["1"].excerpt_ref, `${anchor.axis} band 1`).toBeDefined();
      expect(anchor.bands["9"].excerpt_ref, `${anchor.axis} band 9`).toBeDefined();
    }
    // loadGrounding() already threw if any ref dangled — this asserts the happy path.
    expect(lib.byId.size).toBe(28);
  });

  it("exemplars are 80–150 words of synthesized prose with full provenance", () => {
    for (const e of lib.exemplars) {
      const words = e.text.split(/\s+/).length;
      expect(words, `${e.id} word count ${words}`).toBeGreaterThanOrEqual(80);
      expect(words, `${e.id} word count ${words}`).toBeLessThanOrEqual(150);
      expect(e.method).toBe("synthesized");
      expect(e.author).toBe("claude-fable-5");
      expect(e.anchor_show.length).toBeGreaterThan(2);
    }
  });
});
