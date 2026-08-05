import { PIN_MAX_COUNT, PIN_MAX_TOKENS } from "@/lib/blocks/assemble";
import { describe, expect, it } from "vitest";
import { type PinPostResponse, pinNoticeText } from "../pin-notice";

/**
 * The pin notice's four cases (§5.4). The route decides the facts; this file
 * pins the sentence the player actually reads for each of them — including the
 * one M3R3 found missing, where a pin is BOTH withheld by the window and
 * unaffordable once the window releases it.
 */

const full: PinPostResponse = {
  carried: false,
  reason: "in_window",
  wouldExceedBudget: true,
  head: { count: PIN_MAX_COUNT, tokens: 400 },
  limits: { maxCount: PIN_MAX_COUNT, maxTokens: PIN_MAX_TOKENS },
};

describe("pinNoticeText", () => {
  it("carried: the head holds it verbatim", () => {
    expect(pinNoticeText({ carried: true })).toBe("Pinned — held verbatim at the head of memory.");
  });

  it("in-window with room: 'later, by design' — and nothing more", () => {
    const text = pinNoticeText({ ...full, wouldExceedBudget: false });
    expect(text).toContain("once that scene compacts");
    // No capacity warning when there is capacity: the optimistic sentence is
    // the TRUE sentence here.
    expect(text).not.toContain("capacity");
  });

  it("in-window AND unaffordable: both halves, capacity named", () => {
    const text = pinNoticeText(full);
    expect(text).toContain("once that scene compacts");
    expect(text).toContain(
      `the head is at capacity (${PIN_MAX_COUNT} of ${PIN_MAX_COUNT} passages)`,
    );
    expect(text).toContain("it will need room when it becomes eligible");
  });

  it("names the bound that actually binds — tokens, when the count is not full", () => {
    const text = pinNoticeText({ ...full, head: { count: 2, tokens: 1_990 } });
    expect(text).toContain(`about 1990 of ${PIN_MAX_TOKENS} tokens`);
    expect(text).not.toContain("passages)");
  });

  it("dropped outright: the make-room sentence, unchanged", () => {
    const text = pinNoticeText({ ...full, reason: "budget" });
    expect(text).toContain("NOT carried");
    expect(text).toContain("Remove one in the notes panel to make room");
  });

  it("no body at all: the failure says so", () => {
    expect(pinNoticeText(null)).toBe("Pin failed.");
  });

  it("an older server (no additive fields) still reads correctly", () => {
    // Backward compatibility is load-bearing: `wouldExceedBudget` absent must
    // never invent a capacity warning.
    const text = pinNoticeText({ carried: false, reason: "in_window" });
    expect(text).toContain("once that scene compacts");
    expect(text).not.toContain("capacity");
  });
});
