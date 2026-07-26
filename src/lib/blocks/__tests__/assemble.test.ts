import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it, vi } from "vitest";
import {
  type BlockInputs,
  CACHE_WALKBACK_BLOCKS,
  type ExchangeRow,
  MAX_CACHE_BREAKPOINTS,
  PIN_MAX_COUNT,
  assembleBlocks,
  block3Text,
  selectPins,
} from "../assemble";
import { WINDOW_MAX_EXCHANGES, naiveCompactor, shouldCompact } from "../compaction";

const exchange = (n: number): ExchangeRow => ({
  turnNumber: n,
  playerInput: `input ${n}`,
  narration: `The scene for turn ${n} unfolds.`,
});

const inputs = (overrides: Partial<BlockInputs> = {}): BlockInputs => ({
  settei: "# Settei\n\nRegister: clipped.",
  beats: [{ position: 0, content: "Earlier, a bluff at the docks.", isEpoch: false }],
  exchanges: [exchange(1), exchange(2)],
  pins: [],
  watermark: 0,
  ...overrides,
});

const pin = (position: number, content: string, sourceTurn = 0) => ({
  position,
  content,
  sourceTurn,
});

const window = (n: number): ExchangeRow[] => Array.from({ length: n }, (_, i) => exchange(i + 1));

const breakpointIndexes = (system: TextBlockParam[]): number[] =>
  system.flatMap((b, i) => (b.cache_control ? [i] : []));

/**
 * The pre-C3 single-block rendering of Block 3, frozen here on purpose.
 * C3 moved cache boundaries; the load-bearing claim is that it moved NOTHING
 * ELSE. Deliberately independent of the module (its own exchange rendering,
 * its own joins) so a change to either side shows up as a diff, not a drift.
 */
function legacyBlock3(input: BlockInputs): string {
  const { kept } = selectPins(input.pins, input.watermark);
  const pinText =
    kept.length === 0
      ? ""
      : `## Pinned passages (player-held, verbatim)\n\n${kept.map((p) => p.content).join("\n\n")}\n\n`;
  const windowText = [...input.exchanges]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((e) => `[Turn ${e.turnNumber}]\nPlayer: ${e.playerInput}\n\n${e.narration}`)
    .join("\n\n");
  return `${pinText}## Recent play (verbatim)\n\n${windowText}`;
}

describe("BYTE EQUALITY: per-exchange blocks concatenate to the pre-C3 single block", () => {
  const cases: Array<[string, BlockInputs]> = [
    ["no pins, two exchanges", inputs()],
    ["pins at the head", inputs({ pins: [pin(0, "Whatever happens, happens."), pin(1, "Bang.")] })],
    ["a single exchange", inputs({ exchanges: [exchange(7)] })],
    ["a full window at the compaction trigger", inputs({ exchanges: window(16) })],
    ["a full window with pins", inputs({ exchanges: window(16), pins: [pin(0, "Bang.")] })],
    ["exchanges handed in out of turn order", inputs({ exchanges: [exchange(3), exchange(1)] })],
    [
      "narration carrying blank lines and trailing whitespace",
      inputs({
        exchanges: [
          { turnNumber: 1, playerInput: "look up  ", narration: "Rain.\n\n\nThen nothing.  \n" },
          { turnNumber: 2, playerInput: "", narration: "\n\nHe does not answer." },
        ],
      }),
    ],
  ];
  for (const [name, fixture] of cases) {
    it(name, () => {
      const { system } = assembleBlocks(fixture);
      expect(block3Text(system)).toBe(legacyBlock3(fixture));
    });
  }

  it("EMPTY WINDOW is the one deliberate deviation: no exchanges → no orphan header", () => {
    const fixture = inputs({ exchanges: [] });
    const { system } = assembleBlocks(fixture);
    // Pre-C3 turn 1 wrote a "recent play" promise with nothing under it.
    expect(legacyBlock3(fixture)).toBe("## Recent play (verbatim)\n\n");
    expect(block3Text(system)).toBe("");
    expect(system).toHaveLength(2);
  });

  it("pins over an empty window: the pin head renders, the header still does not", () => {
    // The deviation composes with pins (SZ-era pins before any play): B3 is
    // the pin text alone, and legacy differs by exactly the orphan header.
    const fixture = inputs({ exchanges: [], pins: [pin(0, "Bang.")] });
    const { system } = assembleBlocks(fixture);
    const pinText = "## Pinned passages (player-held, verbatim)\n\nBang.\n\n";
    expect(block3Text(system)).toBe(pinText);
    expect(legacyBlock3(fixture)).toBe(`${pinText}## Recent play (verbatim)\n\n`);
    expect(system).toHaveLength(3);
  });
});

describe("assembleBlocks (§5.6, amended 2026-07-26)", () => {
  it("no pins: B1 · B2 · header · one block per exchange, breakpoints on B1/B2/tail", () => {
    const { system } = assembleBlocks(inputs());
    expect(system).toHaveLength(5);
    expect(system[2]?.text).toBe("## Recent play (verbatim)\n\n");
    expect(system[3]?.text).toBe("[Turn 1]\nPlayer: input 1\n\nThe scene for turn 1 unfolds.");
    expect(system[4]?.text).toBe("\n\n[Turn 2]\nPlayer: input 2\n\nThe scene for turn 2 unfolds.");
    expect(breakpointIndexes(system)).toEqual([0, 1, 4]);
    for (const block of system) expect(block.type).toBe("text");
    for (const i of breakpointIndexes(system)) {
      expect(system[i]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }
  });

  it("pins present: the pin head takes breakpoint 3 and the window tail takes breakpoint 4", () => {
    const { system } = assembleBlocks(inputs({ pins: [pin(0, "Bang.")] }));
    expect(system).toHaveLength(6);
    expect(system[2]?.text).toBe("## Pinned passages (player-held, verbatim)\n\nBang.\n\n");
    expect(breakpointIndexes(system)).toEqual([0, 1, 2, 5]);
  });

  it("turn 1 (no exchanges) emits no window blocks at all", () => {
    expect(assembleBlocks(inputs({ exchanges: [] })).system).toHaveLength(2);
    const pinned = assembleBlocks(inputs({ exchanges: [], pins: [pin(0, "Bang.")] })).system;
    expect(pinned).toHaveLength(3);
    expect(breakpointIndexes(pinned)).toEqual([0, 1, 2]);
  });

  it("NEVER exceeds the API's four breakpoints, at any window size or pin count", () => {
    // Windows at n=18 legitimately cross the walk-back warn threshold — spy
    // the warn so the sweep stays silent on stderr (the warn's own behavior
    // is pinned in its dedicated test below).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let n = 0; n <= 18; n++) {
        for (const pins of [[], [pin(0, "Bang.")], [pin(0, "Bang."), pin(1, "See you, cowboy.")]]) {
          const { system } = assembleBlocks(inputs({ exchanges: window(n), pins }));
          expect(breakpointIndexes(system).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
        }
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("PREFIX STABILITY: an append leaves every prior block byte-identical and adds exactly one", () => {
    const before = assembleBlocks(inputs());
    const after = assembleBlocks(inputs({ exchanges: [exchange(1), exchange(2), exchange(3)] }));
    expect(after.system).toHaveLength(before.system.length + 1);
    for (const [i, block] of before.system.entries()) {
      expect(after.system[i]?.text).toBe(block.text);
    }
    // The tail breakpoint MOVES: it leaves the old last block (which now reads
    // at 0.1x) and lands on the one new block (the only 2x write of the turn).
    const oldTail = before.system.length - 1;
    expect(before.system[oldTail]?.cache_control).toBeTruthy();
    expect(after.system[oldTail]?.cache_control).toBeUndefined();
    expect(after.system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(breakpointIndexes(after.system)).toEqual([0, 1, after.system.length - 1]);
  });

  it("a pin ADD busts the pin head but leaves Blocks 1-2 and the window byte-identical", () => {
    const base = inputs();
    const before = assembleBlocks(base);
    const after = assembleBlocks({ ...base, pins: [pin(0, "Whatever happens, happens.")] });
    expect(after.system[0]?.text).toBe(before.system[0]?.text);
    expect(after.system[1]?.text).toBe(before.system[1]?.text);
    expect(after.system[2]?.text).toContain("Pinned passages");
    expect(after.system.slice(3).map((b) => b.text)).toEqual(
      before.system.slice(2).map((b) => b.text),
    );
  });

  it("warns — never throws — when the window reaches the cache walk-back margin", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // header + 17 exchanges = 18 blocks: inside the margin.
      assembleBlocks(inputs({ exchanges: window(CACHE_WALKBACK_BLOCKS - 3) }));
      expect(spy).not.toHaveBeenCalled();
      // header + 18 exchanges = 19 blocks: one short of the walk-back ceiling.
      const at = assembleBlocks(inputs({ exchanges: window(CACHE_WALKBACK_BLOCKS - 2) }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(at.system.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("beats render in position order into Block 2; empty beats still render a live block", () => {
    const shuffled = assembleBlocks(
      inputs({
        beats: [
          { position: 1, content: "second beat", isEpoch: false },
          { position: 0, content: "first beat", isEpoch: false },
        ],
      }),
    );
    const b2 = shuffled.system[1]?.text ?? "";
    expect(b2.indexOf("first beat")).toBeLessThan(b2.indexOf("second beat"));
    const empty = assembleBlocks(inputs({ beats: [] }));
    expect(empty.system[1]?.text).toContain("just beginning");
  });

  it("budgets are reported for §10.8 assertions", () => {
    const { budgets } = assembleBlocks(inputs());
    expect(budgets.totalTokens).toBe(budgets.b1Tokens + budgets.b2Tokens + budgets.b3Tokens);
    expect(budgets.totalTokens).toBeGreaterThan(0);
  });
});

describe("pins (§5.4: ≤5, ≤2k tokens, dedup by source turn, order-stable)", () => {
  it("withholds a pin whose SOURCE exchange is still in the window (sourceTurn > watermark)", () => {
    const { kept, dropped } = selectPins([pin(0, "The scene for turn 1 unfolds.", 1)], 0);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("renders the pin once compaction moves its source into Block 2 — pins survive compaction", () => {
    const { kept } = selectPins([pin(0, "The scene for turn 1 unfolds.", 1)], 1);
    expect(kept).toHaveLength(1);
  });

  it("MEMBERSHIP STABILITY: an exchange quoting a kept pin verbatim does not flip membership or break the prefix", () => {
    const catchphrase = "Whatever happens, happens.";
    const base = inputs({ pins: [pin(0, catchphrase, 0)] });
    const before = assembleBlocks(base);
    expect(block3Text(before.system)).toContain(catchphrase);
    // The KA echoes the pinned wording in the next turn's narration —
    // exactly what pins invite. Membership must not flip (C5 audit).
    const echo = {
      turnNumber: 3,
      playerInput: "say it back to him",
      narration: `He grins. "${catchphrase}" The words hang in the smoke.`,
    };
    const after = assembleBlocks({ ...base, exchanges: [...base.exchanges, echo] });
    expect(after.droppedPins).toHaveLength(0);
    expect(block3Text(after.system).startsWith(block3Text(before.system))).toBe(true);
    // Block-list form: the pin head and every prior window block are untouched.
    for (const [i, block] of before.system.entries()) {
      expect(after.system[i]?.text).toBe(block.text);
    }
  });

  it("caps at PIN_MAX_COUNT, keeping lowest positions", () => {
    const pins = Array.from({ length: 7 }, (_, i) => pin(i, `pin ${i}`));
    const { kept, dropped } = selectPins(pins, 0);
    expect(kept).toHaveLength(PIN_MAX_COUNT);
    expect(kept.map((p) => p.position)).toEqual([0, 1, 2, 3, 4]);
    expect(dropped).toHaveLength(2);
  });

  it("enforces the 2k-token budget", () => {
    const huge = "x".repeat(9_000); // ~2250 tokens
    const { kept, dropped } = selectPins([pin(0, huge), pin(1, "small pin")], 0);
    expect(kept.map((p) => p.position)).toEqual([1]);
    expect(dropped.map((p) => p.position)).toEqual([0]);
  });

  it("orders deterministically on tied positions", () => {
    const tied = [pin(0, "bravo"), pin(0, "alpha")];
    const first = selectPins(tied, 0);
    const second = selectPins([...tied].reverse(), 0);
    expect(first.kept.map((p) => p.content)).toEqual(second.kept.map((p) => p.content));
  });

  it("dropped pins are surfaced by assembleBlocks, never silent", () => {
    const { droppedPins } = assembleBlocks(
      inputs({ pins: [pin(0, "The scene for turn 1 unfolds.", 2)], watermark: 0 }),
    );
    expect(droppedPins).toHaveLength(1);
  });
});

describe("compaction triggers (§6.2)", () => {
  it("fires past the exchange ceiling", () => {
    const window = Array.from({ length: WINDOW_MAX_EXCHANGES + 1 }, (_, i) => exchange(i + 1));
    expect(shouldCompact(window)).toBe(true);
  });

  it("fires past the token ceiling even with few exchanges", () => {
    const fat: ExchangeRow = { turnNumber: 1, playerInput: "x", narration: "y".repeat(70_000) };
    expect(shouldCompact([fat])).toBe(true);
  });

  it("holds inside both ceilings", () => {
    expect(shouldCompact([exchange(1), exchange(2)])).toBe(false);
  });

  it("naive compactor emits one clipped beat per exchange (M0 stub)", async () => {
    const beats = await naiveCompactor([exchange(1), exchange(2)]);
    expect(beats).toHaveLength(2);
    expect(beats[0]).toContain("(t1)");
  });
});
