import { MAX_PLAY_VIEW_REWIND } from "@/lib/turn/rewind";
import { describe, expect, it } from "vitest";
import {
  RETAKE_HORIZON,
  type RetakeItem,
  beyondRetakeHorizon,
  firstUnwoundInput,
  latestTurnNumber,
  openingRetakeAvailable,
  retakeDraftKey,
  retakeSeamKey,
  retakeTargets,
  unwoundBoothCount,
  unwoundCount,
} from "../retake";

/**
 * The retake's rules (M2R7). The mode itself is browser-verified (C10); what
 * is pinned here is the LAW the surface obeys: which replies are places you can
 * return to, how much un-happens, what the composer inherits — and that no
 * affordance is offered that the route would 400.
 */

const story = (turnNumber: number, playerInput = `act ${turnNumber}`): RetakeItem => ({
  kind: "story",
  turnNumber,
  playerInput,
});
const booth = (turnNumber: number): RetakeItem => ({
  kind: "channel",
  turnNumber,
  playerInput: "/meta how am I doing",
});

/** Server-hydrated story rows arrive with no `kind` at all (page.tsx sets it,
 *  but the Exchange type leaves it optional) — absent must read as story. */
const bare = (turnNumber: number): RetakeItem => ({ turnNumber, playerInput: `act ${turnNumber}` });

describe("the retake horizon", () => {
  it("mirrors the route's bound — the UI never offers what the server rejects", () => {
    expect(RETAKE_HORIZON).toBe(MAX_PLAY_VIEW_REWIND);
  });

  it("counts turn NUMBERS, not story beats (booth lines burn numbers too)", () => {
    const items = [story(1), booth(2), story(3)];
    expect(latestTurnNumber(items)).toBe(3);
    expect(beyondRetakeHorizon(items, 1)).toBe(false);
  });

  it("marks a turn beyond the horizon once it is >10 numbers back", () => {
    const items = Array.from({ length: 14 }, (_, i) => story(i + 1));
    expect(beyondRetakeHorizon(items, 3)).toBe(true); // 14 - 3 === 11
    expect(beyondRetakeHorizon(items, 4)).toBe(false); // 14 - 4 === 10, the edge
  });
});

describe("retakeTargets", () => {
  it("every story reply with a story turn after it, inside the horizon", () => {
    const targets = retakeTargets([story(1), story(2), story(3)]);
    expect([...targets].sort()).toEqual([1, 2]);
  });

  it("the newest reply is not a target — returning there un-happens nothing", () => {
    expect(retakeTargets([story(1), story(2)]).has(2)).toBe(false);
  });

  it("booth lines are never targets (§5.4/C9 — not places in the story)", () => {
    const targets = retakeTargets([story(1), booth(2), story(3)]);
    expect(targets.has(2)).toBe(false);
    expect(targets.has(1)).toBe(true);
  });

  it("a story turn whose only successor is a booth line is not a target", () => {
    // Nothing of the STORY un-happens, so "3 turns un-happen" would be a lie.
    expect(retakeTargets([story(1), story(2), booth(3)]).has(2)).toBe(false);
  });

  it("drops replies past the horizon", () => {
    const items = Array.from({ length: 14 }, (_, i) => story(i + 1));
    const targets = retakeTargets(items);
    expect(targets.has(3)).toBe(false);
    expect(targets.has(4)).toBe(true); // 14 - 4 === 10
    expect(targets.has(13)).toBe(true);
    expect(targets.has(14)).toBe(false);
  });

  it("treats a kind-less server row as story", () => {
    expect(retakeTargets([bare(1), bare(2)]).has(1)).toBe(true);
  });

  it("an empty transcript offers nothing", () => {
    expect(retakeTargets([]).size).toBe(0);
  });
});

describe("unwoundCount", () => {
  it("counts story turns after the kept turn, never booth lines", () => {
    const items = [story(1), story(2), booth(3), story(4), story(5)];
    expect(unwoundCount(items, 2)).toBe(2);
    expect(unwoundCount(items, 4)).toBe(1);
    expect(unwoundCount(items, 0)).toBe(4);
  });
});

describe("firstUnwoundInput — the draft the composer inherits", () => {
  it("is the first STORY input after the kept turn", () => {
    const items = [story(1, "kick the door"), booth(2), story(3, "pick the lock"), story(4, "run")];
    expect(firstUnwoundInput(items, 1)).toBe("pick the lock");
  });

  it("reads the opening input for a return to turn 0", () => {
    expect(firstUnwoundInput([story(1, "Begin."), story(2)], 0)).toBe("Begin.");
  });

  it("is null when nothing un-happens, or the input was blank", () => {
    expect(firstUnwoundInput([story(1)], 1)).toBeNull();
    expect(firstUnwoundInput([story(1, "   ")], 0)).toBeNull();
  });

  it("does not depend on transcript ordering", () => {
    expect(firstUnwoundInput([story(3, "third"), story(2, "second")], 1)).toBe("second");
  });
});

describe("openingRetakeAvailable", () => {
  it("offers the opening while the whole story is inside the horizon", () => {
    expect(openingRetakeAvailable([story(1), story(2)])).toBe(true);
    expect(openingRetakeAvailable(Array.from({ length: 10 }, (_, i) => story(i + 1)))).toBe(true);
  });

  it("withdraws it once the story runs past the horizon (the route would 400)", () => {
    expect(openingRetakeAvailable(Array.from({ length: 11 }, (_, i) => story(i + 1)))).toBe(false);
  });

  it("is unavailable on an empty transcript, or with no story turn to un-happen", () => {
    expect(openingRetakeAvailable([])).toBe(false);
    expect(openingRetakeAvailable([booth(1)])).toBe(false);
  });
});

describe("the session keys", () => {
  it("are per-campaign so two tabs never inherit each other's draft", () => {
    expect(retakeDraftKey("abc")).toBe("aidm:play:retake-draft:abc");
    expect(retakeSeamKey("abc")).toBe("aidm:play:retake-seam:abc");
    expect(retakeDraftKey("abc")).not.toBe(retakeDraftKey("xyz"));
  });
});

describe("audit hardening (M2R7)", () => {
  it("a story item at turn 0 is never a Return-here target — restart is the anchor's job", () => {
    // A payload that defaulted a missing turnNumber to 0 must not render an
    // affordance that quietly posts toTurn: 0 under the non-opening slate.
    const items = [story(0), story(1), story(2)];
    expect(retakeTargets(items).has(0)).toBe(false);
    expect(retakeTargets(items).has(1)).toBe(true);
  });

  it("unwoundBoothCount counts the channel exchanges the dim already hazes", () => {
    // [story5, booth6, story7] → returning to 5 un-happens 1 story turn AND
    // 1 booth exchange; the slate says both (the count and the dim agree).
    const items = [story(5), booth(6), story(7)];
    expect(unwoundCount(items, 5)).toBe(1);
    expect(unwoundBoothCount(items, 5)).toBe(1);
    expect(unwoundBoothCount(items, 6)).toBe(0);
  });
});
