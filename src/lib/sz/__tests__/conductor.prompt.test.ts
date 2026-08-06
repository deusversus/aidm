import {
  CompositionMode,
  NarrativeFocus,
  PowerExpression,
  TensionSource,
} from "@/lib/types/composition";
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

  it("the presentation beat offers the six display devices premise-natively (M3-DG)", () => {
    const beat = CONDUCTOR_SYSTEM.slice(CONDUCTOR_SYSTEM.indexOf("presentation vocabulary:"));
    for (const device of ["window", "readout", "letter", "title", "memory", "comms"]) {
      expect(beat).toContain(device);
    }
    // Records a STRUCTURED grant the compiler resolves; premise-native, never a
    // menu (Berserk gets bare prose, Solo Leveling its System window).
    expect(beat).toContain('"presentation_directive"');
    expect(beat).toContain("Berserk is offered bare prose");
    // The memory MARKING is universal — offered at every table.
    expect(beat).toContain("memory MARKING is available at every table");
    expect(ObservationKind.options).toContain("presentation_directive");
  });

  it("the stinger is asked as taste, anchored yes/no, and never as a feature (M3R4 B4)", () => {
    const beat = CONDUCTOR_SYSTEM.slice(
      CONDUCTOR_SYSTEM.indexOf("- the stinger:"),
      CONDUCTOR_SYSTEM.indexOf("- suggestion affordance:"),
    );
    expect(beat.length).toBeGreaterThan(0);
    expect(beat).toContain("after the credits");
    // Taste, offered only where the premise earns the question — the display
    // devices' own discipline, not a form field.
    expect(beat).toContain("as TASTE");
    expect(beat).toContain("only where the premise makes it a real question");
    // The compiler reads the ANSWER first (resolveObservations' anchor).
    expect(beat).toContain('BEGIN with exactly "yes" or "no"');
    expect(beat).toContain("no stinger is the table's default");
    expect(ObservationKind.options).toContain("stinger");
    // And the ITINERARY itself knows the beat exists (bounded slice — the
    // conductor navigates by it, so a beat missing there is never reached).
    const itinerary = CONDUCTOR_SYSTEM.slice(
      CONDUCTOR_SYSTEM.indexOf("THE ITINERARY"),
      CONDUCTOR_SYSTEM.indexOf("THE AUDITION"),
    );
    expect(itinerary).toContain("whether this show does a stinger");
  });

  it("THE LAW CHANNEL routes an off-instrument resolution to premise_law (M2R6)", () => {
    expect(CONDUCTOR_SYSTEM).toContain("THE LAW CHANNEL");
    expect(CONDUCTOR_SYSTEM).toContain('"premise_law"');
    expect(ObservationKind.options).toContain("premise_law");
    // The three rules that were bent at the China Shop, and the case that
    // named the commit: absence is the one thing the pen cannot infer.
    expect(CONDUCTOR_SYSTEM).toContain("never decorate an enum token with a gloss");
    expect(CONDUCTOR_SYSTEM).toContain("never coin a value");
    expect(CONDUCTOR_SYSTEM).toContain("NEGATIVE SPACE");
    // A deferral and a law are opposites, and must never be filed as each other.
    expect(CONDUCTOR_SYSTEM).toContain("Never file one as the other");
  });

  it("the framing beat carries the CLOSED vocabularies and the law fallthrough (M2R6)", () => {
    // "Not on the enum" is unknowable unless the enum is in the prompt — the
    // routing rule is stated where framing_choice is taught, with its tokens.
    const beat = CONDUCTOR_SYSTEM.slice(
      CONDUCTOR_SYSTEM.indexOf("THE POWER TIER"),
      CONDUCTOR_SYSTEM.indexOf("WHAT YOU GATHER"),
    );
    // Derived from the SOURCE enums, not hand-copied samples — a
    // composition.ts edit must fail here, never drift the prompt silently
    // (C2 audit).
    for (const token of [
      ...TensionSource.options,
      ...PowerExpression.options,
      ...NarrativeFocus.options,
      ...CompositionMode.options,
    ]) {
      expect(beat).toContain(token);
    }
    expect(beat).toContain("premise_law");
    expect(beat).toContain("CLOSED SETS");
  });

  it("the recap beat reads the carved laws back before anything is signed (M2R6)", () => {
    const bar = CONDUCTOR_SYSTEM.slice(CONDUCTOR_SYSTEM.indexOf("WHEN THE TABLE IS SET"));
    expect(bar).toContain("OPEN ITEMS");
    expect(bar).toContain("CARVED LAWS");
    expect(bar).toContain("READ THEM BACK");
    expect(bar).toContain("UNREAD RECORDS");
  });

  it("THE POWER TIER beat exists, walks the four options, records both kinds (SV3)", () => {
    expect(CONDUCTOR_SYSTEM).toContain("THE POWER TIER");
    for (const walk of ["below baseline", "at baseline", "far above"]) {
      expect(CONDUCTOR_SYSTEM).toContain(walk);
    }
    // The gap-≥2 composition offer, with v3's parsing-table flavor.
    expect(CONDUCTOR_SYSTEM).toContain("2+ TIERS ABOVE BASELINE");
    expect(CONDUCTOR_SYSTEM).toContain('"pc_power_tier"');
    expect(CONDUCTOR_SYSTEM).toContain('"framing_choice"');
    expect(ObservationKind.options).toContain("pc_power_tier");
    expect(ObservationKind.options).toContain("framing_choice");
  });
});
