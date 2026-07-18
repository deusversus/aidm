import { describe, expect, it } from "vitest";
import {
  type BlockInputs,
  type ExchangeRow,
  PIN_MAX_COUNT,
  assembleBlocks,
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

describe("assembleBlocks (§5.6)", () => {
  it("emits exactly three system blocks, each carrying a cache breakpoint", () => {
    const { system } = assembleBlocks(inputs());
    expect(system).toHaveLength(3);
    for (const block of system) {
      expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(block.type).toBe("text");
    }
  });

  it("PREFIX STABILITY: appending an exchange leaves the prior B3 as a strict string prefix", () => {
    const before = assembleBlocks(inputs());
    const after = assembleBlocks(inputs({ exchanges: [exchange(1), exchange(2), exchange(3)] }));
    expect(after.system[2]?.text.startsWith(before.system[2]?.text ?? "!")).toBe(true);
    expect(after.system[2]?.text.length).toBeGreaterThan(before.system[2]?.text.length ?? 0);
    // Blocks 1 and 2 are untouched by an append.
    expect(after.system[0]?.text).toBe(before.system[0]?.text);
    expect(after.system[1]?.text).toBe(before.system[1]?.text);
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
    expect(after.system[2]?.text.startsWith(before.system[2]?.text ?? "!")).toBe(true);
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
