import { plainProse } from "@/lib/client/plain-prose";
import { describe, expect, it } from "vitest";
import {
  SPEECH_CHAR_CAP,
  SPEECH_SEGMENT_CHAR_CAP,
  SPEECH_TOTAL_CHAR_CAP,
  speechSegments,
  speechText,
} from "../speech-text";

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

describe("speechSegments (the sequential listen player's projection)", () => {
  const sentence = "The rain fell on the dock and nobody said a single word about it. ";

  it("splits long narration into segments, each within the per-segment cap", () => {
    const long = sentence.repeat(200); // ~13k chars, over the total cap
    const segments = speechSegments(long);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.length).toBeGreaterThan(0);
      expect(seg.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHAR_CAP);
    }
  });

  it("breaks only at sentence boundaries for normal prose", () => {
    const long = sentence.repeat(100); // ~6.5k chars, several segments
    const segments = speechSegments(long);
    expect(segments.length).toBeGreaterThan(1);
    // Normal prose never splits mid-sentence: every segment ends on a stop.
    for (const seg of segments) {
      expect(/[.!?]$/.test(seg)).toBe(true);
    }
  });

  it("reconstructs the capped text exactly when segments are rejoined", () => {
    const src = "The pulse went on and the lamp kept its slow tick over the dock. ".repeat(80);
    const segments = speechSegments(src); // ~5k chars, several segments
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join(" ")).toBe(plainProse(src));
  });

  it("strips markdown before segmenting", () => {
    const md = "*Stop it,* she said.\n\n> radial artery — 2mm below the skin";
    expect(speechSegments(md)).toEqual(["Stop it, she said. radial artery — 2mm below the skin"]);
  });

  it("a single sentence longer than the cap splits at a word boundary", () => {
    const giant = `${"word ".repeat(700)}end.`; // ~3.5k chars, one interior-stopless sentence
    const segments = speechSegments(giant);
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHAR_CAP);
      expect(seg.startsWith(" ")).toBe(false); // whole words at every boundary
      expect(seg.endsWith(" ")).toBe(false);
    }
    expect(segments.join(" ")).toBe(plainProse(giant)); // nothing lost mid-word
  });

  it("applies the total cap before segmentation", () => {
    const long = sentence.repeat(400); // ~26k chars, far over the total cap
    const segments = speechSegments(long);
    expect(segments.join(" ").length).toBeLessThanOrEqual(SPEECH_TOTAL_CHAR_CAP);
  });

  it("a short narration yields exactly one segment", () => {
    const short = "The lamp ticked. The pulse went on.";
    expect(speechSegments(short)).toEqual([short]);
  });

  it("empty or markdown-only narration yields no segments", () => {
    expect(speechSegments("")).toEqual([]);
    expect(speechSegments("   \n\n   ")).toEqual([]);
  });
});
