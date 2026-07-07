import { describe, expect, it } from "vitest";
import {
  DEV_TIER_SELECTION,
  FABLE_FALLBACK_MODEL,
  FABLE_MODEL,
  MODEL_CAPS,
  SERVER_SIDE_FALLBACK_BETA,
  TIER_MENUS,
  TierSelection,
} from "../tiers";

describe("tier menus (§3 — player-facing, closed)", () => {
  it("menus match the blueprint exactly", () => {
    expect(TIER_MENUS.narration).toEqual(["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"]);
    expect(TIER_MENUS.judgment).toEqual(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"]);
    expect(TIER_MENUS.probe).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it("TierSelection rejects off-menu models per tier", () => {
    expect(() =>
      TierSelection.parse({
        narration: "claude-haiku-4-5", // not on the narration menu
        judgment: "claude-haiku-4-5",
        probe: "claude-haiku-4-5",
      }),
    ).toThrow();
    expect(() =>
      TierSelection.parse({
        narration: "claude-sonnet-5",
        judgment: "claude-sonnet-5",
        probe: "claude-fable-5", // not on the probe menu
      }),
    ).toThrow();
  });

  it("the dev default is on-menu and cheapest-rung", () => {
    expect(() => TierSelection.parse(DEV_TIER_SELECTION)).not.toThrow();
    expect(DEV_TIER_SELECTION.judgment).toBe("claude-haiku-4-5");
  });

  it("every menu model has a capabilities entry", () => {
    const all = new Set([...TIER_MENUS.narration, ...TIER_MENUS.judgment, ...TIER_MENUS.probe]);
    for (const model of all) {
      expect(MODEL_CAPS[model], model).toBeDefined();
    }
  });

  it("Haiku 4.5 gets neither adaptive thinking nor effort control (pre-4.6 API)", () => {
    expect(MODEL_CAPS["claude-haiku-4-5"]).toEqual({
      adaptiveThinking: false,
      effortControl: false,
    });
  });

  it("Fable omits the thinking param (always-on) but keeps effort control", () => {
    expect(MODEL_CAPS[FABLE_MODEL]).toEqual({ adaptiveThinking: false, effortControl: true });
  });

  it("Fable fallback constants match §3", () => {
    expect(FABLE_FALLBACK_MODEL).toBe("claude-opus-4-8");
    expect(SERVER_SIDE_FALLBACK_BETA).toBe("server-side-fallback-2026-06-01");
  });
});
