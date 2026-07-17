import { describe, expect, it } from "vitest";
import { CONDUCTOR_SYSTEM, ObservationKind } from "../conductor";

/**
 * SV2 opening spec (docs/plans/M2-sz-voice.md): the conductor's identity is
 * the player's ANIME table, the model menu stays out of the greeting, the
 * canon seat is never assumed, and canonicality is walked as doors. Pure
 * string asserts — the prompt is the product's first handshake, so its
 * load-bearing phrases are pinned like any other contract.
 */

const openingStart = CONDUCTOR_SYSTEM.indexOf("THE OPENING");
const openingEnd = CONDUCTOR_SYSTEM.indexOf("THE ITINERARY");
const opening = CONDUCTOR_SYSTEM.slice(openingStart, openingEnd);

describe("conductor system prompt spec (SV2 — the voice)", () => {
  it("identifies as the player's anime table — never a story studio", () => {
    expect(CONDUCTOR_SYSTEM).toContain("anime table");
    expect(CONDUCTOR_SYSTEM.toLowerCase()).not.toContain("story studio");
  });

  it("the opening block is intact and carries no cost-dial or model-menu language", () => {
    expect(openingStart).toBeGreaterThan(-1);
    expect(openingEnd).toBeGreaterThan(openingStart);
    // The model menu arrives at its own beat (SV2) — the greeting sells the
    // table, never the machinery.
    for (const term of ["cost dial", "cost/intelligence", "Sonnet", "Opus", "Fable", "model"]) {
      expect(opening).not.toContain(term);
    }
    // The invitation is anime-first — v3's oldest question survives.
    expect(opening).toContain("which anime");
  });

  it("THE CONCEPT beat exists, never assumes the canon seat, and records pc_concept", () => {
    expect(CONDUCTOR_SYSTEM).toContain("THE CONCEPT");
    expect(CONDUCTOR_SYSTEM).toContain("never your assumption");
    expect(CONDUCTOR_SYSTEM).toContain("BIG IDEA");
    expect(CONDUCTOR_SYSTEM).toContain('"pc_concept"');
    expect(ObservationKind.options).toContain("pc_concept");
  });

  it("canonicality is walked as three doors, with the enum vocabulary unchanged", () => {
    expect(CONDUCTOR_SYSTEM).toContain("THREE doors");
    for (const token of [
      "canon_adjacent",
      "alternate",
      "inspired",
      "full_cast",
      "replaced_protagonist",
      "npcs_only",
      "observable",
      "influenceable",
      "background",
    ]) {
      expect(CONDUCTOR_SYSTEM).toContain(token);
    }
  });

  it("the concept is on the table-is-set bar", () => {
    const bar = CONDUCTOR_SYSTEM.slice(CONDUCTOR_SYSTEM.indexOf("WHEN THE TABLE IS SET"));
    expect(bar).toContain("CONCEPT");
  });
});
