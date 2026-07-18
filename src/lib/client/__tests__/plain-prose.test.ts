import { describe, expect, it } from "vitest";
import { plainProse } from "../plain-prose";

/**
 * Pin-from-selection substrate: the selection comes from RENDERED prose,
 * the stored narration is raw markdown — the projection must make them
 * meet. Fixtures mirror the live Return by Design idioms.
 */

describe("plainProse (pin-from-selection projection)", () => {
  it("strips emphasis the way rendering does", () => {
    expect(plainProse("*Stop it,* Lilith told the machine")).toBe(
      "Stop it, Lilith told the machine",
    );
    expect(plainProse("the **honest** bright want")).toBe("the honest bright want");
    expect(plainProse("a word _held_ in __teeth__")).toBe("a word held in teeth");
  });

  it("a selection inside a readout block matches the raw blockquote", () => {
    const raw = [
      "> radial artery — 2mm below the skin at the wrist crease",
      "> the woman's pulse: 74, steady, unguarded",
    ].join("\n");
    // What the DOM yields when the player drags across both rendered lines.
    const selection = "radial artery — 2mm below the skin at the wrist crease the woman's pulse:";
    expect(plainProse(raw)).toContain(selection.replace(/\s+/g, " ").trim());
  });

  it("headings, rules, and inline code flatten; whitespace collapses", () => {
    expect(plainProse("## Episode 4\n\n---\n\nShe stood `still`.")).toBe(
      "Episode 4 She stood still.",
    );
  });

  it("plain text passes through untouched (minus whitespace collapse)", () => {
    const plain = "The lamp ticked. The pulse went on, 74, steady, unguarded.";
    expect(plainProse(plain)).toBe(plain);
  });

  it("snake_case jargon survives — intraword underscores are NOT emphasis (CommonMark)", () => {
    // The audit repro: the renderer keeps these underscores, so the
    // projection must too, or pins on readout lines silently lose their
    // source turn.
    const jargon = "> grant: mana_core — passive, on_request_only";
    expect(plainProse(jargon)).toBe("grant: mana_core — passive, on_request_only");
    expect(plainProse("stored_at dawn, opens_at dusk")).toBe("stored_at dawn, opens_at dusk");
  });

  it("space-flanked asterisks are NOT emphasis (CommonMark)", () => {
    expect(plainProse("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("list markers project out — ::marker text is unselectable in the DOM", () => {
    expect(plainProse("- first item\n- second item")).toBe("first item second item");
    expect(plainProse("3. Find the sword\n4. Return by design")).toBe(
      "Find the sword Return by design",
    );
  });

  it("strikethrough projects to its rendered text", () => {
    expect(plainProse("she ~~lied~~ said")).toBe("she lied said");
  });
});
