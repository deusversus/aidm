import type { DirectiveGrant } from "@/lib/types/premise";
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
 *   [3] Working memory: the pin head, then the verbatim exchange tail —
 *       APPEND-ONLY between compaction events. Rendered as DISCRETE blocks:
 *       pin head (breakpoint 3) · window header · one block per exchange,
 *       with breakpoint 4 riding the LAST exchange block and MOVING each
 *       turn (§5.6, amended 2026-07-26).
 *   [4] The conte — dynamic, uncached, rendered into the user message by
 *       the turn engine (not this module).
 *
 * Why the window breathes in exchanges (M2R5 C3, measured 2026-07-26): as
 * one growing text block, B3 re-wrote its whole window at the 2× 1h-write
 * rate every turn — a 12k-token median creation per first-narration-call
 * that nothing read back, because 60 of 82 turns made exactly one narration
 * call and the next turn's growth busted the entry again. With a moving tail
 * breakpoint the prior window reads at 0.1× and only the new exchange
 * writes. The prompt the model reads is byte-identical either way — only the
 * cache boundaries moved, and `assemble.test.ts` pins that equality.
 *
 * Append-only by construction: this module exposes no mutation surface at
 * all — it renders whatever rows it is given, and the row sources are
 * themselves append-only (episodic records insert-only; compaction is the
 * single sanctioned truncation, implemented in compaction.ts as
 * beats-written + watermark-advanced, never row edits). The prefix-
 * stability tests assert the cache invariant directly: appending an
 * exchange leaves every prior block byte-identical and adds exactly one.
 */

export interface ExchangeRow {
  turnNumber: number;
  playerInput: string;
  narration: string;
}

/**
 * §8 presentation grants, rendered for Block 1 — with the channel contract
 * (SV4): a granted device carries the tense/diegesis it was granted for,
 * the Settei-side half of the KA contract's camera law. The M3-DG structured
 * half (`directives`) teaches the granted display-device NAMES + skins the KA
 * writes as fenced blocks. Empty grants AND empty directives render nothing
 * (bare-prose premises get no chrome and no contract). Kept compact: this
 * rides Block 1, which is cached across the session.
 */
export function renderPresentationGrants(
  grants: string[],
  directives: DirectiveGrant[] = [],
): string {
  if (grants.length === 0 && directives.length === 0) return "";
  let out = "";
  if (grants.length > 0) {
    out += `\n\n## Presentation vocabulary (granted — use at your judgment, never as obligation)\n${grants
      .map((g) => `- ${g}`)
      .join(
        "\n",
      )}\nEach grant carries the tense and diegesis it was granted for. A channel the campaign has taught the player to read one way never silently carries another time or another speaker — when a granted device does double duty, mark the variant so the cut is visible (the camera law, below).`;
  }
  if (directives.length > 0) {
    out += `\n\n## Display devices (granted — diegetic fenced blocks, used at your judgment)\nWrite a device as a fenced block whose info string is its name (\`\`\`readout … \`\`\`); the surface renders its chrome. The fenced inner text is PLAIN story prose — pins, the Gauge, and compaction read it as prose, so nothing load-bearing lives only inside a device.\n${directives
      .map((d) => `- \`${d.name}\`${d.skin ? ` — ${d.skin}` : ""}`)
      .join("\n")}`;
    // The memory MARKING is universal (M3-DG): even where the premise set no
    // skin, a not-now/not-real passage can be marked and will render legibly.
    if (!directives.some((d) => d.name === "memory")) {
      out +=
        "\n- `memory` — always available: mark any not-now / not-real passage (a flashback should look like one), even unskinned.";
    }
  }
  return out;
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

/** The API's hard ceiling on `cache_control` markers in one request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * A cache read walks back at most this many blocks from a breakpoint looking
 * for a match. Everything between the pin/Block-2 breakpoint and the moving
 * tail is the window, so the window's block count is the number that has to
 * stay under the ceiling. Compaction (trigger 16, keep-tail 10) should hold
 * it at ≤16 exchanges + header, but the assembly checks rather than trusting
 * that cadence forever.
 */
export const CACHE_WALKBACK_BLOCKS = 20;

/** Blocks 1 and 2 come first; everything after them is Block 3. */
export const B3_FIRST_BLOCK_INDEX = 2;

const WINDOW_HEADER = "## Recent play (verbatim)\n\n";

/**
 * What the model actually reads as Block 3 — the window blocks concatenated.
 * The split into blocks is a CACHE fact, not a prompt fact: this string is
 * byte-identical to the single block the assembler emitted before M2R5 C3.
 */
export function block3Text(system: TextBlockParam[]): string {
  return system
    .slice(B3_FIRST_BLOCK_INDEX)
    .map((b) => b.text)
    .join("");
}

export interface AssembledBlocks {
  /**
   * Blocks 1–3 as system blocks. Breakpoints: Block 1 tail · Block 2 tail ·
   * pin head (when pins exist) · last exchange block (moving).
   */
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

  // The `\n\n` that joins two exchanges rides the HEAD of the later block,
  // never the tail of the earlier one: a trailing separator would rewrite the
  // previous block on every append, which is the exact rewrite this structure
  // exists to stop.
  const windowTexts = [...inputs.exchanges]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((e, i) => (i === 0 ? renderExchange(e) : `\n\n${renderExchange(e)}`));

  // C9 (§5.6, measured 2026-07-18): live inter-turn think-time runs 19-65
  // minutes within a sitting (p50 ~36m) — ZERO gaps fell under 5 minutes,
  // 80% under 1 hour. A 5m TTL never survives a real player; every
  // breakpoint writes at 1h (2x write premium, priced in llm/pricing.ts;
  // the §5.6 pre-warm covers the over-an-hour tail).
  const breakpoint = { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } };
  const system: TextBlockParam[] = [
    { type: "text", text: b1, ...breakpoint },
    { type: "text", text: b2, ...breakpoint },
  ];
  if (pinText.length > 0) {
    // Pins get their own breakpoint so a rare pin add busts pins + window and
    // never Blocks 1–2.
    system.push({ type: "text", text: pinText, ...breakpoint });
  }
  // An empty window (turn 1) renders NO header — the one byte C3 deliberately
  // stopped writing: the pre-C3 block promised "recent play" with nothing
  // under it. Every non-empty window is byte-for-byte what it always was.
  if (windowTexts.length > 0) {
    system.push({ type: "text", text: WINDOW_HEADER });
    for (const [i, text] of windowTexts.entries()) {
      const isTail = i === windowTexts.length - 1;
      system.push({ type: "text", text, ...(isTail ? breakpoint : {}) });
    }
  }

  const b3 = block3Text(system);

  const breakpointCount = system.filter((b) => b.cache_control).length;
  if (breakpointCount > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `assembleBlocks emitted ${breakpointCount} cache breakpoints; the API allows ${MAX_CACHE_BREAKPOINTS}`,
    );
  }

  // Degraded caching is not a failed turn — this warns, never throws. If it
  // ever fires, compaction's cadence has drifted past the walk-back margin
  // and the window's reads are silently missing.
  const windowBlockCount = system.length - B3_FIRST_BLOCK_INDEX - (pinText.length > 0 ? 1 : 0);
  if (windowBlockCount >= CACHE_WALKBACK_BLOCKS - 1) {
    console.warn(
      "[blocks] Block-3 window is at the cache walk-back margin — compaction is overdue and reads will start missing",
      {
        windowBlockCount,
        walkBackLimit: CACHE_WALKBACK_BLOCKS,
        exchanges: inputs.exchanges.length,
      },
    );
  }

  const budgets = {
    b1Tokens: approxTokens(b1),
    b2Tokens: approxTokens(b2),
    b3Tokens: approxTokens(b3),
    pinTokens: approxTokens(pinText),
    totalTokens: approxTokens(b1) + approxTokens(b2) + approxTokens(b3),
  };
  return { system, budgets, droppedPins: dropped };
}
