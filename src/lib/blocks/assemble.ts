import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { approxTokens } from "./tokens";

/**
 * The four-block prompt strategy (blueprint §5.6), as pure assembly.
 *
 * Block order and lifetimes:
 *   [1] Settei + world rules — changes only at session boundaries / premise
 *       edits (§4.4a). Cached; its tail is breakpoint 1.
 *   [2] Compacted history — changes only at compaction events (§6.2).
 *       Cached; its tail is breakpoint 2.
 *   [3] Working memory: pins at the head, then the verbatim exchange tail —
 *       APPEND-ONLY between compaction events. Cached; its tail is
 *       breakpoint 3, refreshed each turn.
 *   [4] The conte — dynamic, uncached, rendered into the user message by
 *       the turn engine (not this module).
 *
 * Append-only by construction: this module exposes no mutation surface at
 * all — it renders whatever rows it is given, and the row sources are
 * themselves append-only (episodic records insert-only; compaction is the
 * single sanctioned truncation, implemented in compaction.ts as
 * beats-written + watermark-advanced, never row edits). The prefix-
 * stability tests assert the cache invariant directly: appending an
 * exchange must leave the previously rendered prompt as a strict string
 * prefix of the new one.
 */

export interface ExchangeRow {
  turnNumber: number;
  playerInput: string;
  narration: string;
}

/**
 * §8 presentation grants, rendered for Block 1 — with the channel contract
 * (SV4): a granted device carries the tense/diegesis it was granted for,
 * the Settei-side half of the KA contract's camera law. Empty grants render
 * nothing (no channels granted, no contract needed).
 */
export function renderPresentationGrants(grants: string[]): string {
  if (grants.length === 0) return "";
  return `\n\n## Presentation vocabulary (granted — use at your judgment, never as obligation)\n${grants.map((g) => `- ${g}`).join("\n")}\nEach grant carries the tense and diegesis it was granted for. A channel the campaign has taught the player to read one way never silently carries another time or another speaker — when a granted device does double duty, mark the variant so the cut is visible (the camera law, below).`;
}

export interface BeatRow {
  position: number;
  content: string;
  isEpoch: boolean;
}

export interface PinRow {
  position: number;
  content: string;
  /** Turn the passage was pinned from; 0 = unknown/pre-play. */
  sourceTurn: number;
}

export interface BlockInputs {
  /** Rendered Settei + hard world rules — the Renderer's artifact (M1). */
  settei: string;
  /** Compacted beats, ordered by position. */
  beats: BeatRow[];
  /** The working window: episodic exchanges past the compaction watermark, ordered by turn. */
  exchanges: ExchangeRow[];
  /** Player pins, ordered by position (§5.4: ≤5, ≤2k tokens total). */
  pins: PinRow[];
  /** The compaction watermark (last turn compacted into Block 2) — pin dedup keys on it. */
  watermark: number;
}

export const PIN_MAX_COUNT = 5;
export const PIN_MAX_TOKENS = 2_000;

export interface AssembledBlocks {
  /** Blocks 1–3 as system blocks, each tail carrying a cache breakpoint. */
  system: TextBlockParam[];
  budgets: {
    b1Tokens: number;
    b2Tokens: number;
    b3Tokens: number;
    pinTokens: number;
    totalTokens: number;
  };
  /** Pins dropped by the ≤5/≤2k bound or window dedup — surfaced, never silent. */
  droppedPins: PinRow[];
}

function renderExchange(e: ExchangeRow): string {
  return `[Turn ${e.turnNumber}]\nPlayer: ${e.playerInput}\n\n${e.narration}`;
}

/**
 * Pins are deduped against the window BY SOURCE TURN, never by text: a
 * pin whose source exchange is still in the verbatim tail (sourceTurn >
 * watermark) would appear twice, so it's withheld until compaction moves
 * its source into Block 2 — which is exactly how "pins survive compaction"
 * (§5.4) is delivered. Text-scanning dedup is forbidden here: membership
 * would flip mid-session whenever narration echoes the pinned wording
 * (pins are catchphrases; echoes are the point), invalidating the B3
 * prefix with no sanctioned event. Membership is therefore a function of
 * (pins, watermark) alone and can only change at compaction events or pin
 * edits — both sanctioned rewrites.
 *
 * Ordering is deterministic (position, then sourceTurn, then content) —
 * a nondeterministic head would also invalidate the prefix.
 */
export function selectPins(
  pins: PinRow[],
  watermark: number,
): { kept: PinRow[]; dropped: PinRow[] } {
  const ordered = [...pins].sort(
    (a, b) =>
      a.position - b.position || a.sourceTurn - b.sourceTurn || a.content.localeCompare(b.content),
  );
  const kept: PinRow[] = [];
  const dropped: PinRow[] = [];
  let budget = 0;
  for (const pin of ordered) {
    const cost = approxTokens(pin.content);
    if (
      pin.sourceTurn > watermark ||
      kept.length >= PIN_MAX_COUNT ||
      budget + cost > PIN_MAX_TOKENS
    ) {
      dropped.push(pin);
      continue;
    }
    kept.push(pin);
    budget += cost;
  }
  return { kept, dropped };
}

export function assembleBlocks(inputs: BlockInputs): AssembledBlocks {
  const b1 = inputs.settei;

  const b2 =
    inputs.beats.length === 0
      ? "## Story so far\n\n(The story is just beginning.)"
      : `## Story so far\n\n${[...inputs.beats]
          .sort((a, b) => a.position - b.position)
          .map((b) => b.content)
          .join("\n\n")}`;

  const { kept, dropped } = selectPins(inputs.pins, inputs.watermark);
  const pinText =
    kept.length === 0
      ? ""
      : `## Pinned passages (player-held, verbatim)\n\n${kept.map((p) => p.content).join("\n\n")}\n\n`;
  const windowText = [...inputs.exchanges]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map(renderExchange)
    .join("\n\n");
  const b3 = `${pinText}## Recent play (verbatim)\n\n${windowText}`;

  const breakpoint = { cache_control: { type: "ephemeral" as const } };
  const system: TextBlockParam[] = [
    { type: "text", text: b1, ...breakpoint },
    { type: "text", text: b2, ...breakpoint },
    { type: "text", text: b3, ...breakpoint },
  ];

  const budgets = {
    b1Tokens: approxTokens(b1),
    b2Tokens: approxTokens(b2),
    b3Tokens: approxTokens(b3),
    pinTokens: approxTokens(pinText),
    totalTokens: approxTokens(b1) + approxTokens(b2) + approxTokens(b3),
  };
  return { system, budgets, droppedPins: dropped };
}
