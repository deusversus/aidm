import { plainProse } from "@/lib/client/plain-prose";

/**
 * Narration → speech text (the listen button's projection). The stored
 * narration is markdown; a voice must not read "greater-than radial artery"
 * or asterisks. plainProse (the pin projection) does the stripping; this
 * adds the provider cap — ElevenLabs rejects very long bodies, and a scene
 * that somehow exceeds the cap gets cut at a sentence boundary rather than
 * mid-word.
 */
export const SPEECH_CHAR_CAP = 9_000;

export function speechText(narration: string): string {
  const plain = plainProse(narration);
  if (plain.length <= SPEECH_CHAR_CAP) return plain;
  const cut = plain.slice(0, SPEECH_CHAR_CAP);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > SPEECH_CHAR_CAP * 0.5) return cut.slice(0, lastStop + 1);
  // Degenerate prose (no sentence stops in the window): cut at a word
  // boundary; only a single unbroken 9k-char token falls back to a raw cut.
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}
