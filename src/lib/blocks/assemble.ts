import type { DirectiveGrant } from "@/lib/types/premise";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { approxTokens } from "./tokens";

/**
 * The four-block prompt strategy (blueprint §5.6), as pure assembly —
 * amended M3R2 C2: THE PEN'S OWN HAND.
 *
 * Block order and lifetimes:
 *   [1] Settei + world rules — changes only at session boundaries / premise
 *       edits (§4.4a). System; cached; its tail is breakpoint 1.
 *   [2] Compacted history — changes only at compaction events and epoch
 *       merges (§6.2), both sanctioned wholesale rewrites. System; cached;
 *       its tail is breakpoint 2. Pins (player-held passages) ride a third
 *       system block with their own breakpoint.
 *   [3] Working memory — the verbatim exchange window — is NO LONGER system
 *       text. It renders as REAL CONVERSATION TURNS: the player's input as a
 *       user message, the narration as an ASSISTANT message. The wiring
 *       audit (2026-08-03) found the disparate-writer symptom was the
 *       architecture: the KA received its own prose as an unattributed
 *       system transcript with zero assistant turns in its own conversation
 *       — structurally "a writer handed someone else's manuscript." Now the
 *       model sees its prior scenes as its OWN turns, the shape the API's
 *       conversation contract was built for. Still APPEND-ONLY between
 *       compaction events; breakpoint 4 rides the LAST assistant message
 *       and MOVES each turn (M2R5 C3's cache discipline, relocated).
 *   [4] The conte — dynamic, uncached, rendered as the FINAL user message by
 *       the turn engine (not this module).
 *
 * Cache economics carry over from M2R5 C3 unchanged: prior exchange
 * messages read at 0.1×; only the new pair writes; compaction remains the
 * single sanctioned shrink event. The prefix-stability tests assert the
 * invariant in message form: appending an exchange leaves every prior
 * message byte-identical and adds exactly one user+assistant pair.
 *
 * Append-only by construction: this module exposes no mutation surface at
 * all — it renders whatever rows it is given, and the row sources are
 * themselves append-only (episodic records insert-only; compaction is the
 * single sanctioned truncation, implemented in compaction.ts as
 * beats-written + watermark-advanced, never row edits).
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
 * for a match. Post-C2 this bound is structurally safe: the moving tail
 * breakpoint advances by one exchange pair (2 blocks) per turn, so a read
 * never walks farther than pair + conte — the old window-size tripwire is
 * retired (see the note at the assembly site).
 */
export const CACHE_WALKBACK_BLOCKS = 20;

/**
 * The window as the model-visible transcript — for budgets, tests, and any
 * reader that wants Block 3 as text. One entry per exchange message.
 */
export function exchangesText(messages: MessageParam[]): string {
  return messages
    .map((m) =>
      (Array.isArray(m.content) ? m.content : [{ type: "text" as const, text: String(m.content) }])
        .map((b) => ("text" in b ? b.text : ""))
        .join(""),
    )
    .join("\n\n");
}

export interface AssembledBlocks {
  /**
   * Blocks 1–2 + pins as system blocks. Breakpoints: Block 1 tail · Block 2
   * tail · pin block (when pins exist).
   */
  system: TextBlockParam[];
  /**
   * Block 3 as REAL conversation turns (M3R2 C2): user = the player's input
   * (turn-labelled), assistant = the narration VERBATIM — the pen's own
   * hand, attributed. Breakpoint 4 (moving) rides the last message. The
   * turn engine appends the conte as the final user message; the booth and
   * the recap thread these ahead of their own frames.
   */
  exchangeMessages: MessageParam[];
  budgets: {
    b1Tokens: number;
    b2Tokens: number;
    b3Tokens: number;
    pinTokens: number;
    totalTokens: number;
    /**
     * How many of Block 2's rows are epoch summaries (§6.2). Free to compute
     * and it is the one number that tells a §10.8 budget reading whether a
     * small b2Tokens means "young campaign" or "century of play, folded".
     */
    epochCount: number;
  };
  /** Pins dropped by the ≤5/≤2k bound or window dedup — surfaced, never silent. */
  droppedPins: PinRow[];
}

/** The player's half — the role IS the attribution; the label keeps turn
 *  references legible (numbering may skip: channel turns consume numbers). */
function exchangeUserText(e: ExchangeRow): string {
  return `[Turn ${e.turnNumber}]\n${e.playerInput}`;
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
    // Pins get their own breakpoint so a rare pin add busts pins and never
    // Blocks 1–2 (the window lives in messages and is untouched by a pin).
    system.push({ type: "text", text: pinText, ...breakpoint });
  }

  // Block 3 as conversation (M3R2 C2): one user + one assistant message per
  // exchange, in turn order. The moving breakpoint rides the LAST message's
  // content block. An empty window (turn 1) is an empty array.
  // An empty text block is an API 400 ("text content blocks must be
  // non-empty") — a blank-narration row would permanently kill every
  // narration call for the campaign (C2 review MUST-FIX). The runtime
  // rejects empty narration before the episodic insert, so this is
  // defense against a corrupt row: the whole pair skips, loudly, because
  // rendering the user half alone would break the conversation.
  const ordered = [...inputs.exchanges]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .filter((e) => {
      if (e.narration.trim() === "") {
        console.warn("[blocks] exchange with EMPTY narration — pair skipped (corrupt row)", {
          turnNumber: e.turnNumber,
        });
        return false;
      }
      return true;
    });
  const exchangeMessages: MessageParam[] = [];
  for (const [i, e] of ordered.entries()) {
    const isLast = i === ordered.length - 1;
    exchangeMessages.push({
      role: "user",
      content: [{ type: "text", text: exchangeUserText(e) }],
    });
    exchangeMessages.push({
      role: "assistant",
      content: [{ type: "text", text: e.narration, ...(isLast ? breakpoint : {}) }],
    });
  }

  const b3 = exchangesText(exchangeMessages);

  const systemBreakpoints = system.filter((b) => b.cache_control).length;
  const messageBreakpoints = exchangeMessages.length > 0 ? 1 : 0;
  if (systemBreakpoints + messageBreakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `assembleBlocks emitted ${systemBreakpoints + messageBreakpoints} cache breakpoints; the API allows ${MAX_CACHE_BREAKPOINTS}`,
    );
  }

  // The walk-back tripwire is RETIRED (C2 review): the risk it guarded died
  // with the relocation. Pre-C2 a compaction could rewrite the whole window
  // behind one breakpoint; now the distance a read must walk back from the
  // moving tail is exactly one exchange pair (2 blocks) plus the conte —
  // structurally under the ~20-block walk-back at any window size. The old
  // threshold (>=19 message blocks) would have fired on EVERY healthy
  // assembly, since compaction's keep-tail alone is 12 exchanges = 24
  // blocks: a permanently-tripped alarm is worse than none.

  const budgets = {
    b1Tokens: approxTokens(b1),
    b2Tokens: approxTokens(b2),
    b3Tokens: approxTokens(b3),
    pinTokens: approxTokens(pinText),
    totalTokens: approxTokens(b1) + approxTokens(b2) + approxTokens(pinText) + approxTokens(b3),
    epochCount: inputs.beats.filter((b) => b.isEpoch).length,
  };
  return { system, exchangeMessages, budgets, droppedPins: dropped };
}
