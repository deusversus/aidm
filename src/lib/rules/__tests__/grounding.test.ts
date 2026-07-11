import { AXIS_NAMES, COVERED_AXES } from "@/lib/types/grounding";
import { describe, expect, it } from "vitest";
import { loadGrounding } from "../grounding";

describe("grounding library (§4.6–4.7, gap rule)", () => {
  const lib = loadGrounding();

  it("covers ALL 24 axes with anchors and both extremes (M2-C6 full build-out)", () => {
    expect(COVERED_AXES).toHaveLength(AXIS_NAMES.length);
    expect(lib.anchors.length).toBeGreaterThanOrEqual(AXIS_NAMES.length);
    expect(lib.exemplars).toHaveLength(AXIS_NAMES.length * 2);
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
    expect(lib.byId.size).toBe(AXIS_NAMES.length * 2);
  });

  it("exemplars are 80–160 words of synthesized prose with full provenance", () => {
    // Authorship is honest attribution: the M0/M1 set was written by Fable,
    // the M2-C6 build-out by Opus subagents. Any Claude model is legitimate;
    // what matters is method: synthesized (§13 — never verbatim source).
    for (const e of lib.exemplars) {
      const words = e.text.split(/\s+/).length;
      expect(words, `${e.id} word count ${words}`).toBeGreaterThanOrEqual(80);
      expect(words, `${e.id} word count ${words}`).toBeLessThanOrEqual(160);
      expect(e.method).toBe("synthesized");
      expect(e.author, `${e.id} author ${e.author}`).toMatch(/^claude-/);
      expect(e.anchor_show.length).toBeGreaterThan(2);
    }
  });
});
