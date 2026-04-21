import { describe, expect, it } from "vitest";
import {
  BOOST_ON_ACCESS,
  CATEGORY_DECAY,
  DECAY_CURVES,
  STATIC_BOOST,
  curveFor,
  heatFloor,
} from "../decay";

/**
 * Decay physics tests (Phase 4 v3-audit closure). Exercise the pure
 * helpers directly. `decayHeat` + `boostHeatOnAccess` round-trip the
 * DB; those are acceptance-ritual targets and covered indirectly by
 * turn-workflow integration (once Chronicler fires the decay pass in
 * a follow-up commit).
 */

describe("DECAY_CURVES — v3-parity values", () => {
  it("none is 1.0 (no decay)", () => {
    expect(DECAY_CURVES.none).toBe(1.0);
  });
  it("very_slow through very_fast covers the v3 range", () => {
    expect(DECAY_CURVES.very_slow).toBe(0.97);
    expect(DECAY_CURVES.slow).toBe(0.95);
    expect(DECAY_CURVES.normal).toBe(0.9);
    expect(DECAY_CURVES.fast).toBe(0.8);
    expect(DECAY_CURVES.very_fast).toBe(0.7);
  });
});

describe("CATEGORY_DECAY — critical mappings (v3-parity)", () => {
  it("session_zero categories never decay", () => {
    expect(CATEGORY_DECAY.core).toBe("none");
    expect(CATEGORY_DECAY.session_zero).toBe("none");
    expect(CATEGORY_DECAY.session_zero_voice).toBe("none");
  });
  it("relationship uses very_slow (bonds build slowly)", () => {
    expect(CATEGORY_DECAY.relationship).toBe("very_slow");
  });
  it("episode uses very_fast (one-episode summaries expire quickly)", () => {
    expect(CATEGORY_DECAY.episode).toBe("very_fast");
  });
  it("character_state uses fast (hunger, fatigue expire)", () => {
    expect(CATEGORY_DECAY.character_state).toBe("fast");
  });
});

describe("curveFor — fallback behavior", () => {
  it("returns the mapped curve when known", () => {
    expect(curveFor("relationship")).toBe("very_slow");
    expect(curveFor("episode")).toBe("very_fast");
  });
  it("returns 'normal' for unknown categories (Chronicler can nominate new categories)", () => {
    expect(curveFor("bizarre_new_category")).toBe("normal");
    expect(curveFor("")).toBe("normal");
  });
});

describe("heatFloor — respects flags", () => {
  it("plot_critical → floors at current heat (never decays below its last-known value)", () => {
    expect(heatFloor({ plot_critical: true }, 85)).toBe(85);
    expect(heatFloor({ plot_critical: true }, 50)).toBe(50);
  });
  it("milestone_relationship → floor 40", () => {
    expect(heatFloor({ milestone_relationship: true }, 100)).toBe(40);
    expect(heatFloor({ milestone_relationship: true }, 20)).toBe(40);
  });
  it("plot_critical wins over milestone_relationship when both set", () => {
    expect(heatFloor({ plot_critical: true, milestone_relationship: true }, 75)).toBe(75);
  });
  it("no flags → floor 1 (retains a trace for retrieval)", () => {
    expect(heatFloor({}, 100)).toBe(1);
    expect(heatFloor(null, 50)).toBe(1);
    expect(heatFloor(undefined, 30)).toBe(1);
  });
});

describe("BOOST_ON_ACCESS — per-category retrieval bumps", () => {
  it("relationship gets +30 (stays hotter)", () => {
    expect(BOOST_ON_ACCESS.relationship).toBe(30);
  });
  it("default is +20", () => {
    expect(BOOST_ON_ACCESS.default).toBe(20);
  });
});

describe("STATIC_BOOST — M4 retrieval-ranking scaffolding", () => {
  it("session_zero + plot_critical get +0.3 (same boost, two paths)", () => {
    expect(STATIC_BOOST.session_zero).toBe(0.3);
    expect(STATIC_BOOST.plot_critical).toBe(0.3);
  });
  it("episode gets +0.15 (half the priority bump)", () => {
    expect(STATIC_BOOST.episode).toBe(0.15);
  });
});

describe("Decay formula — compound multiplier math", () => {
  /**
   * Sanity-check the intended formula: heat_new = heat_old × multiplier^delta_turns.
   * The live decayHeat function runs this in SQL; here we verify the
   * mental model matches what decay.ts documents.
   */
  it("slow (0.95) × 10 turns = 59.87 of original 100", () => {
    const slow = DECAY_CURVES.slow;
    const result = 100 * slow ** 10;
    expect(result).toBeCloseTo(59.87, 1);
  });
  it("very_fast (0.7) × 5 turns = 16.8 of original 100", () => {
    const vfast = DECAY_CURVES.very_fast;
    const result = 100 * vfast ** 5;
    expect(result).toBeCloseTo(16.81, 1);
  });
  it("none (1.0) × 100 turns = 100 (no decay)", () => {
    expect(100 * DECAY_CURVES.none ** 100).toBe(100);
  });
});
