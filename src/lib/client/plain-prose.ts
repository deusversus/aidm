/**
 * Plaintext projection of narration markdown — the pin-from-selection
 * substrate. The player selects RENDERED text (no asterisks, no `> `
 * prefixes, no list markers — ::marker text is unselectable); the stored
 * narration is raw markdown. Matching happens on this projection with
 * collapsed whitespace on both sides.
 *
 * The projection mirrors what the renderer actually does (audit repros
 * against the installed pipeline): `_` is NEVER emphasis intraword
 * (snake_case System jargon survives), `*` is never emphasis when
 * space-flanked ("2 * 3 * 4" survives), list markers and ~~strikethrough~~
 * are rendered constructs and project out. A heuristic, not a parser: a
 * miss degrades to sourceTurn 0, so near-enough beats exact.
 */
export function plainProse(md: string): string {
  return md
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^[-*_]{3,}[ \t]*$/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, "$1")
    .replace(/(?<![A-Za-z0-9])__(\S(?:[^_\n]*?\S)?)__(?![A-Za-z0-9])/g, "$1")
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, "$1")
    .replace(/(?<![A-Za-z0-9])_(\S(?:[^_\n]*?\S)?)_(?![A-Za-z0-9])/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
