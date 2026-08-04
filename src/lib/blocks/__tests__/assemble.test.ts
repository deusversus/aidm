import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it, vi } from "vitest";
import {
  type BlockInputs,
  CACHE_WALKBACK_BLOCKS,
  type ExchangeRow,
  MAX_CACHE_BREAKPOINTS,
  PIN_MAX_COUNT,
  assembleBlocks,
  exchangesText,
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

const msgText = (m: MessageParam | undefined): string =>
  m === undefined
    ? ""
    : Array.isArray(m.content)
      ? m.content.map((b) => ("text" in b ? b.text : "")).join("")
      : String(m.content);

const msgBreakpointIndexes = (messages: MessageParam[]): number[] =>
  messages.flatMap((m, i) =>
    Array.isArray(m.content) && m.content.some((b) => "cache_control" in b && b.cache_control)
      ? [i]
      : [],
  );

// ---------------------------------------------------------------------------
// M3R2 C2 — THE PEN'S OWN HAND. The pre-C3 byte-equality lineage ends here BY
// DESIGN: the wiring audit (2026-08-03) found the KA received its own prose
// as an unattributed system transcript with zero assistant turns — the
// disparate-writer symptom as architecture. The window now renders as real
// user/assistant conversation turns, and the load-bearing invariants are
// attribution, verbatim fidelity, and the relocated cache discipline.
// ---------------------------------------------------------------------------

describe("the pen's own hand (M3R2 C2): the window is attributed conversation", () => {
  it("N exchanges → alternating user/assistant pairs; the narration is the assistant's OWN turn, verbatim", () => {
    const { exchangeMessages } = assembleBlocks(inputs());
    expect(exchangeMessages).toHaveLength(4);
    expect(exchangeMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgText(exchangeMessages[0])).toBe("[Turn 1]\ninput 1");
    expect(msgText(exchangeMessages[1])).toBe("The scene for turn 1 unfolds.");
    expect(msgText(exchangeMessages[2])).toBe("[Turn 2]\ninput 2");
    expect(msgText(exchangeMessages[3])).toBe("The scene for turn 2 unfolds.");
  });

  it("whitespace fidelity: blank lines and trailing spaces in narration survive untouched", () => {
    const { exchangeMessages } = assembleBlocks(
      inputs({
        exchanges: [
          { turnNumber: 1, playerInput: "look up  ", narration: "Rain.\n\n\nThen nothing.  \n" },
          { turnNumber: 2, playerInput: "", narration: "\n\nHe does not answer." },
        ],
      }),
    );
    expect(msgText(exchangeMessages[1])).toBe("Rain.\n\n\nThen nothing.  \n");
    expect(msgText(exchangeMessages[3])).toBe("\n\nHe does not answer.");
  });

  it("exchanges handed in out of turn order sort into the conversation's real order", () => {
    const { exchangeMessages } = assembleBlocks(inputs({ exchanges: [exchange(3), exchange(1)] }));
    expect(msgText(exchangeMessages[0])).toBe("[Turn 1]\ninput 1");
    expect(msgText(exchangeMessages[2])).toBe("[Turn 3]\ninput 3");
  });

  it("turn 1 (no exchanges): empty conversation, system is B1 · B2 alone", () => {
    const empty = assembleBlocks(inputs({ exchanges: [] }));
    expect(empty.exchangeMessages).toHaveLength(0);
    expect(empty.system).toHaveLength(2);
    const pinned = assembleBlocks(inputs({ exchanges: [], pins: [pin(0, "Bang.")] }));
    expect(pinned.system).toHaveLength(3);
    expect(pinned.system[2]?.text).toContain("Pinned passages");
    expect(breakpointIndexes(pinned.system)).toEqual([0, 1, 2]);
  });

  it("the transcript view (exchangesText) reads in play order — budgets and tests share it", () => {
    const { exchangeMessages, budgets } = assembleBlocks(inputs());
    const t = exchangesText(exchangeMessages);
    expect(t.indexOf("input 1")).toBeLessThan(t.indexOf("The scene for turn 1 unfolds."));
    expect(t.indexOf("The scene for turn 1 unfolds.")).toBeLessThan(t.indexOf("input 2"));
    expect(budgets.b3Tokens).toBeGreaterThan(0);
  });
});

describe("cache discipline (§5.6, relocated to messages — M3R2 C2)", () => {
  it("breakpoints: B1 · B2 in system (pins third when present); exactly ONE in messages, riding the last assistant turn", () => {
    const bare = assembleBlocks(inputs());
    expect(breakpointIndexes(bare.system)).toEqual([0, 1]);
    expect(msgBreakpointIndexes(bare.exchangeMessages)).toEqual([bare.exchangeMessages.length - 1]);
    // The 1h TTL rides every breakpoint (C9's measured think-time law).
    const tail = bare.exchangeMessages.at(-1)?.content;
    if (Array.isArray(tail) && tail[0] && "cache_control" in tail[0]) {
      expect(tail[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    } else {
      throw new Error("tail message lost its content-block shape");
    }
    for (const i of breakpointIndexes(bare.system)) {
      expect(bare.system[i]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    }
    const pinned = assembleBlocks(inputs({ pins: [pin(0, "Bang.")] }));
    expect(breakpointIndexes(pinned.system)).toEqual([0, 1, 2]);
    expect(msgBreakpointIndexes(pinned.exchangeMessages)).toEqual([
      pinned.exchangeMessages.length - 1,
    ]);
  });

  it("NEVER exceeds the API's four breakpoints, at any window size or pin count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let n = 0; n <= 18; n++) {
        for (const pins of [[], [pin(0, "Bang.")], [pin(0, "Bang."), pin(1, "See you, cowboy.")]]) {
          const { system, exchangeMessages } = assembleBlocks(
            inputs({ exchanges: window(n), pins }),
          );
          const total =
            breakpointIndexes(system).length + msgBreakpointIndexes(exchangeMessages).length;
          expect(total).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
        }
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("PREFIX STABILITY: an append leaves every prior message byte-identical and adds exactly one user+assistant pair", () => {
    const before = assembleBlocks(inputs());
    const after = assembleBlocks(inputs({ exchanges: [exchange(1), exchange(2), exchange(3)] }));
    expect(after.exchangeMessages).toHaveLength(before.exchangeMessages.length + 2);
    for (const [i, m] of before.exchangeMessages.entries()) {
      expect(msgText(after.exchangeMessages[i])).toBe(msgText(m));
      expect(after.exchangeMessages[i]?.role).toBe(m.role);
    }
    // The tail breakpoint MOVES: it leaves the old last message (which now
    // reads at 0.1x) and lands on the one new assistant turn (the only 2x
    // write of the turn). The system blocks are untouched entirely.
    const oldTail = before.exchangeMessages.length - 1;
    expect(msgBreakpointIndexes(before.exchangeMessages)).toEqual([oldTail]);
    expect(msgBreakpointIndexes(after.exchangeMessages)).toEqual([
      after.exchangeMessages.length - 1,
    ]);
    for (const [i, block] of before.system.entries()) {
      expect(after.system[i]?.text).toBe(block.text);
    }
  });

  it("a pin ADD busts only the pin block: B1/B2 identical, the conversation completely untouched", () => {
    const base = inputs();
    const before = assembleBlocks(base);
    const after = assembleBlocks({ ...base, pins: [pin(0, "Whatever happens, happens.")] });
    expect(after.system[0]?.text).toBe(before.system[0]?.text);
    expect(after.system[1]?.text).toBe(before.system[1]?.text);
    expect(after.system[2]?.text).toContain("Pinned passages");
    expect(after.exchangeMessages.map(msgText)).toEqual(before.exchangeMessages.map(msgText));
    expect(msgBreakpointIndexes(after.exchangeMessages)).toEqual(
      msgBreakpointIndexes(before.exchangeMessages),
    );
  });

  it("NEVER warns on window size (C2 review: the walk-back risk died with the relocation — per-turn growth is one pair)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Steady-state sizes incl. keep-tail (10) and the trigger band (16+):
      // a permanently-tripped alarm is worse than none.
      for (const n of [9, 10, 16, 20]) {
        assembleBlocks(inputs({ exchanges: window(n) }));
      }
      expect(spy).not.toHaveBeenCalled();
      expect(CACHE_WALKBACK_BLOCKS).toBe(20); // the bound itself stays documented
    } finally {
      spy.mockRestore();
    }
  });

  it("an EMPTY-narration row skips as a pair, loudly — an empty text block is an API 400 (C2 review)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { exchangeMessages } = assembleBlocks(
        inputs({
          exchanges: [exchange(1), { turnNumber: 2, playerInput: "hello?", narration: "   " }],
        }),
      );
      expect(exchangeMessages).toHaveLength(2); // only turn 1's pair
      expect(spy).toHaveBeenCalledTimes(1);
      // The tail breakpoint still lands on the surviving last assistant turn.
      expect(msgBreakpointIndexes(exchangeMessages)).toEqual([1]);
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
    expect(before.system[2]?.text).toContain(catchphrase);
    // The KA echoes the pinned wording in the next turn's narration —
    // exactly what pins invite. Membership must not flip (C5 audit).
    const echo = {
      turnNumber: 3,
      playerInput: "say it back to him",
      narration: `He grins. "${catchphrase}" The words hang in the smoke.`,
    };
    const after = assembleBlocks({ ...base, exchanges: [...base.exchanges, echo] });
    expect(after.droppedPins).toHaveLength(0);
    // The pin block and every prior conversation turn are untouched.
    for (const [i, block] of before.system.entries()) {
      expect(after.system[i]?.text).toBe(block.text);
    }
    for (const [i, m] of before.exchangeMessages.entries()) {
      expect(msgText(after.exchangeMessages[i])).toBe(msgText(m));
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
