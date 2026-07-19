import { describe, expect, it } from "vitest";
import { SPEECH_CHAR_CAP, speechText } from "../speech-text";

describe("speechText (the listen button's projection)", () => {
  it("strips markdown so the voice never reads syntax", () => {
    const md = "*Stop it,* Lilith told the machine.\n\n> radial artery — 2mm below the skin";
    expect(speechText(md)).toBe(
      "Stop it, Lilith told the machine. radial artery — 2mm below the skin",
    );
  });

  it("caps long narration at a sentence boundary, never mid-word", () => {
    const sentence = "The rain fell on the dock and nobody said anything about it. ";
    const long = sentence.repeat(300); // ~18k chars
    const out = speechText(long);
    expect(out.length).toBeLessThanOrEqual(SPEECH_CHAR_CAP);
    expect(out.endsWith(".")).toBe(true);
  });

  it("passes short prose through untouched", () => {
    const plain = "The lamp ticked. The pulse went on.";
    expect(speechText(plain)).toBe(plain);
  });

  it("degenerate stop-less prose cuts at a word boundary (audit #3)", () => {
    const noStops = "word ".repeat(2_500); // 12.5k chars, no sentence stops
    const out = speechText(noStops);
    expect(out.length).toBeLessThanOrEqual(SPEECH_CHAR_CAP);
    expect(out.endsWith("word")).toBe(true); // never a cut mid-token
  });
});
