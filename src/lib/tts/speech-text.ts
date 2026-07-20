import { plainProse } from "@/lib/client/plain-prose";

/**
 * Narration → speech text (the listen button's projection). The stored
 * narration is markdown; a voice must not read "greater-than radial artery"
 * or asterisks. plainProse (the pin projection) does the stripping; this
 * module adds the provider caps — ElevenLabs rejects very long bodies, and a
 * scene that exceeds a cap is cut at a sentence boundary rather than mid-word.
 */

/** Single-shot cap for the legacy speechText path (pinned by tests). */
export const SPEECH_CHAR_CAP = 9_000;

/**
 * Per-segment hard cap for the segmented listen path. The packer targets
 * ~2,000 chars and never exceeds this ceiling; a lone sentence longer than the
 * cap splits at a word boundary.
 */
export const SPEECH_SEGMENT_CHAR_CAP = 2_400;

/**
 * Per-listen total cap for the segmented path — the cost guard that replaces
 * the old 9,000 single-shot limit as the operative total. Real genga/sakuga
 * scenes measure 6–10k chars (the 9-minute Return-by-Design turn 5 that exposed
 * the mid-play stream death ran 8,683); 9,000 was sized before those scenes
 * existed and would silently truncate them, so the segmented path caps the
 * whole listen at 12,000 and splits the body into recoverable segments.
 */
export const SPEECH_TOTAL_CHAR_CAP = 12_000;

/** The packer's soft target — segments break near here, under the hard cap. */
const SPEECH_SEGMENT_TARGET = 2_000;

/** Trim `plain` to `cap` at a sentence boundary when one sits past the
 *  midpoint, else a word boundary; only a single unbroken cap-length token is
 *  cut raw (the degenerate fallback). */
function capAtBoundary(plain: string, cap: number): string {
  if (plain.length <= cap) return plain;
  const cut = plain.slice(0, cap);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > cap * 0.5) return cut.slice(0, lastStop + 1);
  // Degenerate prose (no sentence stops in the window): cut at a word
  // boundary; only a single unbroken cap-char token falls back to a raw cut.
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

export function speechText(narration: string): string {
  return capAtBoundary(plainProse(narration), SPEECH_CHAR_CAP);
}

/** Split one over-cap chunk at word boundaries, each piece ≤ cap. A single
 *  token longer than the cap is the only mid-token cut (matches speechText). */
function splitAtWords(chunk: string, cap: number): string[] {
  if (chunk.length <= cap) return [chunk];
  const pieces: string[] = [];
  let rest = chunk;
  while (rest.length > cap) {
    const window = rest.slice(0, cap);
    const lastSpace = window.lastIndexOf(" ");
    if (lastSpace > 0) {
      pieces.push(rest.slice(0, lastSpace));
      rest = rest.slice(lastSpace + 1);
    } else {
      // A single token longer than the cap: the one sanctioned mid-token cut.
      pieces.push(rest.slice(0, cap));
      rest = rest.slice(cap);
    }
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Narration → ordered speech segments for the sequential listen player
 * (§9.5, 2026-07-20 — a ~9-minute single stream died mid-play). plainProse
 * strips markdown; the total cap guards cost; the body is then packed into
 * sentence-aligned segments each ≤ SPEECH_SEGMENT_CHAR_CAP (targeting ~2,000).
 *
 * Reconstruction contract: for space-separated prose (all realistic narration,
 * post-plainProse whitespace collapse), `segments.join(" ")` equals the capped
 * text — every break removes exactly one separating space, nothing lost or
 * duplicated. The lone exception is a single token longer than the per-segment
 * cap, which is cut raw (the same degenerate fallback speechText accepts).
 */
export function speechSegments(narration: string): string[] {
  const capped = capAtBoundary(plainProse(narration), SPEECH_TOTAL_CHAR_CAP);
  if (!capped) return [];
  // Sentence boundary = a space preceded by a terminator; the lookbehind
  // consumes exactly that one separating space (reconstructable with join(" ")).
  const sentences = capped.split(/(?<=[.!?]) /);
  const packed: string[] = [];
  let cur = "";
  for (const sentence of sentences) {
    if (cur === "") {
      cur = sentence;
    } else if (cur.length + 1 + sentence.length <= SPEECH_SEGMENT_TARGET) {
      cur = `${cur} ${sentence}`;
    } else {
      packed.push(cur);
      cur = sentence;
    }
  }
  if (cur !== "") packed.push(cur);
  // A lone over-cap sentence (rare — one sentence past 2,400 chars) splits at a
  // word boundary; everything else is already within the cap.
  return packed.flatMap((seg) => splitAtWords(seg, SPEECH_SEGMENT_CHAR_CAP));
}
