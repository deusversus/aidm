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

  // C9 (§5.6, measured 2026-07-18): live inter-turn think-time runs 19-65
  // minutes within a sitting (p50 ~36m) — ZERO gaps fell under 5 minutes,
  // 80% under 1 hour. A 5m TTL never survives a real player; every
  // breakpoint writes at 1h (2x write premium, priced in llm/pricing.ts;
  // the §5.6 pre-warm covers the over-an-hour tail).
  const breakpoint = { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } };
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
