import { type DirectiveGrant, DirectiveName } from "@/lib/types/premise";

/**
 * The M3-DG directive registry (pure half — no JSX, so it unit-tests without a
 * DOM). NarrationProse renders a fenced block (` ```readout … ``` `) through
 * this: react-markdown hands the fence's info string as `language-<name>` on
 * the inner <code>; we resolve that name against the campaign's grants and
 * choose the chrome.
 *
 * The law (M3-DG grammar §2–3):
 *  - a GRANTED device → its premise-styled chrome (the skin);
 *  - the UNIVERSAL `memory` device, ungranted → a neutral marking (never the
 *    plain offset fallback — the legibility law is universal);
 *  - any other ungranted device, or an unknown fence name → the plain offset
 *    fallback, logged once per name (never a render error — the KA is corrected
 *    by the Sakkan/dailies, not by the surface).
 */

/** The six starter devices — the closed M3-DG set. */
export const DIRECTIVE_NAMES: ReadonlySet<string> = new Set<string>(DirectiveName.options);

/** `memory` is the one UNIVERSAL device: its marking renders on every campaign
 *  even ungranted, as a neutral marking — never the offset fallback. */
const UNIVERSAL: ReadonlySet<DirectiveName> = new Set<DirectiveName>(["memory"]);

/** Devices whose chrome carries a header eyebrow when the premise gave a skin
 *  (a panel/channel label reads naturally on these; a title/letter/memory does
 *  not). The eyebrow is decorative and select-none so it never pollutes a pin. */
export const EYEBROW_DEVICES: ReadonlySet<DirectiveName> = new Set<DirectiveName>([
  "window",
  "readout",
  "comms",
]);

/**
 * Per-device chrome (Tailwind, theme-token only — the palette is monochrome, so
 * devices are distinguished by SHAPE and typography, never colour). Each entry
 * is distinct and non-empty; the skin colours intent semantically (surfaced as
 * `data-skin` + the eyebrow) rather than by arbitrary CSS.
 */
export const DIRECTIVE_CHROME: Record<DirectiveName | "fallback", string> = {
  // A diegetic UI panel: a bordered, filled box with a header.
  window:
    "my-4 whitespace-pre-wrap rounded-md border border-foreground/30 bg-muted/50 px-4 py-2.5 text-[0.9em] leading-6",
  // An analytical/tactical readout: a left-ruled monospace channel, no full box.
  readout:
    "my-4 whitespace-pre-wrap border-l-2 border-foreground/50 bg-muted/30 px-3 py-2 font-mono text-[0.85em] leading-6",
  // A written artifact: a serif, italic, framed card.
  letter:
    "my-4 rounded-sm border border-border bg-background px-5 py-4 font-serif text-[0.95em] italic leading-7",
  // The episode title card: centred, ruled above and below, wide tracking.
  title:
    "my-6 border-y border-border py-3 text-center text-lg font-semibold uppercase tracking-[0.2em]",
  // The marked not-now/not-real channel: faded, dashed, italic — reads "not now".
  memory:
    "my-4 border-l border-dashed border-foreground/40 pl-4 italic leading-7 text-foreground/70",
  // The conversation channel: a chat-log card that preserves speaker lines.
  comms:
    "my-4 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[0.85em] leading-6",
  // The floor everywhere (M3-DG §5): the plain offset channel (today's blockquote).
  fallback:
    "my-3 whitespace-pre-wrap border-l-2 border-foreground/25 bg-muted/40 px-3 py-1.5 text-[0.93em] leading-6 text-foreground/85",
};

/**
 * Extract a directive name from react-markdown's className. A fenced block with
 * an info string yields `language-<name>`; a fence with NO info string yields no
 * language class (a generic code block — left to the plain <pre>). Returns null
 * for the latter.
 */
export function directiveFenceName(className: string | undefined | null): string | null {
  const m = /(?:^|\s)language-([^\s]+)/.exec(className ?? "");
  return m ? (m[1] ?? null) : null;
}

export type DirectiveResolution =
  | { mode: "styled"; name: DirectiveName; skin: string }
  | { mode: "neutral"; name: DirectiveName }
  | { mode: "fallback"; name: string };

const warned = new Set<string>();

function warnOnce(name: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  // Once per NAME, not per render (M3-DG): a graceful, logged fallback.
  console.warn(
    `[directives] "${name}" is not a granted device on this campaign — rendering the plain offset fallback`,
  );
}

/** Resolve a fence name against the campaign's grants (see the module law). */
export function resolveDirective(
  rawName: string,
  granted: readonly DirectiveGrant[],
): DirectiveResolution {
  const parsed = DirectiveName.safeParse(rawName);
  if (parsed.success) {
    const name = parsed.data;
    const grant = granted.find((g) => g.name === name);
    if (grant) return { mode: "styled", name, skin: grant.skin };
    if (UNIVERSAL.has(name)) return { mode: "neutral", name };
  }
  warnOnce(rawName);
  return { mode: "fallback", name: rawName };
}

/** TEST-ONLY: clear the once-per-name warn ledger so cases are deterministic. */
export function __resetDirectiveWarnings(): void {
  warned.clear();
}
