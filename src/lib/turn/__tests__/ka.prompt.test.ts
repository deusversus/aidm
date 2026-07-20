import { renderPresentationGrants } from "@/lib/blocks/assemble";
import { Conte } from "@/lib/types/conte";
import { describe, expect, it } from "vitest";
import { KA_CONTRACT, renderConte } from "../ka";

/**
 * SV4 camera spec (user-directed 2026-07-18): the KA holds cinematographic
 * awareness as a standing faculty, not per-failure rules — prose is a
 * camera; the player follows the edit like they'd follow anime's visual
 * grammar. Pinned like any contract: load-bearing phrases asserted so a
 * regression is a diff, not a drift. Failure mode: T6 Return by Design
 * (2026-07-17) — a flashback in the live-readout channel read as an
 * unplaced present-tense scene.
 */

describe("KA contract camera faculty (SV4)", () => {
  it("the camera section exists and names the faculty, not a rule list", () => {
    expect(KA_CONTRACT).toContain("## The camera");
    expect(KA_CONTRACT).toContain("Prose is a camera");
    // Awareness spans framing, coverage, and the edit — the three choices
    // the KA is always making whether it knows it or not.
    for (const word of ["framing", "coverage", "the edit"]) {
      expect(KA_CONTRACT).toContain(word);
    }
    // Illustrative techniques present as examples (intercut/simultaneity,
    // flashback), never as the boundary of the toolkit.
    expect(KA_CONTRACT).toContain("intercut");
    expect(KA_CONTRACT).toContain("flashback");
    // The toolkit is licensed UNDER the charter, never against it (audit:
    // a linear premise's "no flashbacks" pressure shares this block).
    expect(KA_CONTRACT).toContain("The whole toolkit is yours");
    expect(KA_CONTRACT).toContain("the charter above has already decided");
  });

  it("the one law: legibility of the edit, visible at the cut", () => {
    expect(KA_CONTRACT).toContain("legibility of the edit");
    expect(KA_CONTRACT).toContain("visible AT the cut");
    // Deliberate ambiguity stays licensed — mystery is craft, not a violation.
    expect(KA_CONTRACT).toContain("on purpose");
  });

  it("established channels keep their contracts (the T6 class)", () => {
    expect(KA_CONTRACT).toContain("keeps its contract");
    expect(KA_CONTRACT).toContain("mark the variant");
  });

  it("the trailer instruction asks for suggested_moves at decision points (M2R R1)", () => {
    // Audit 2026-07-19: nothing ever asked the KA for moves — emission was
    // model whim, so the player's default_on chips almost never appeared.
    expect(KA_CONTRACT).toContain("suggested_moves");
    expect(KA_CONTRACT).toContain("2-3 short premise-true next moves");
    expect(KA_CONTRACT).toContain("omit them when it is false");
  });

  it("the trailer discipline still closes the contract (recency preserved)", () => {
    // The camera section must not displace the measured trailer-drop close
    // from last position (C8: 50% drop rate at long scenes — recency is the fix).
    const camera = KA_CONTRACT.indexOf("## The camera");
    const close = KA_CONTRACT.indexOf("The scene is not finished when the prose ends");
    expect(camera).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(camera);
    // LAST position, not merely after-the-camera: the contract must END on
    // the trailer close — any future section appended below it re-breaks
    // the measured 50% drop rate.
    expect(KA_CONTRACT.trimEnd().endsWith("lossier than your own record.)")).toBe(true);
  });
});

describe("the exit (M2R2)", () => {
  it("the exit faculty carries its load-bearing laws", () => {
    for (const phrase of [
      "## The exit",
      "PRESSURE SURVIVES THE SCENE",
      "END ON THE THING THAT ASKS",
      "THE PLAYER'S INPUT IS THE FLOOR",
    ]) {
      expect(KA_CONTRACT).toContain(phrase);
    }
  });

  it("the world-moves twin pairs with agency (Sacred Rule #3 restored)", () => {
    expect(KA_CONTRACT).toContain("THE WORLD MOVES");
    expect(KA_CONTRACT).toContain("something to decide ABOUT");
  });

  it("the trailer close still ENDS the contract (recency pin holds under the exit section)", () => {
    // The exit section sits BEFORE the trailer close (which the C8 recency fix
    // keeps last); a new faculty must never displace it from final position.
    expect(KA_CONTRACT.trimEnd().endsWith("lossier than your own record.)")).toBe(true);
  });

  it("renderConte surfaces the pacing_note as the Drive line", () => {
    const conte = Conte.parse({
      turn_id: 1,
      tier: "genga",
      pacer_beat: {
        beat_classification: "the knock",
        strength: "suggestion",
        pacing_note: "end on the door opening, not the silence after",
      },
    });
    const storyboard = renderConte(conte, "I wait by the door");
    expect(storyboard).toContain("Drive: ");
    expect(storyboard).toContain("end on the door opening, not the silence after");
  });
});

describe("presentation grants channel contract (SV4, Settei-side)", () => {
  it("grants render with the tense/diegesis contract attached", () => {
    const text = renderPresentationGrants(["diegetic System status windows", "bare prose"]);
    expect(text).toContain("## Presentation vocabulary");
    expect(text).toContain("- diegetic System status windows");
    expect(text).toContain("tense and diegesis it was granted for");
    expect(text).toContain("mark the variant");
  });

  it("no grants, no contract — renders nothing", () => {
    expect(renderPresentationGrants([])).toBe("");
  });
});
