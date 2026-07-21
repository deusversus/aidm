import { describe, expect, it } from "vitest";
import { plainProse, stripDirectiveFences } from "../plain-prose";

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

  it("a selection inside a directive block matches the raw fenced markdown (M3-DG)", () => {
    // The player selects rendered device text (chrome + fence markers gone);
    // the stored narration is a fenced block. The projection must meet it.
    const raw = "```readout\nLILITH: threat critical\n```";
    expect(plainProse(raw)).toBe("LILITH: threat critical");
    const withProse = "She froze.\n\n```window\nHP 12/100\n```\n\nThen she ran.";
    expect(plainProse(withProse)).toBe("She froze. HP 12/100 Then she ran.");
  });
});

describe("stripDirectiveFences (M3-DG chrome removal — the Sakkan-neutrality projection)", () => {
  it("removes fence marker lines, keeping the inner text verbatim", () => {
    const fenced = "The alarm blared.\n\n```readout\nTHREAT: CRITICAL\n```\n\nShe ran.";
    // Identical to the same prose written WITHOUT the device (the neutrality
    // guarantee at the scorer-input level: chrome never changes the story).
    expect(stripDirectiveFences(fenced)).toBe("The alarm blared.\n\nTHREAT: CRITICAL\n\nShe ran.");
  });

  it("strips every device name (info string) and the bare closing fence", () => {
    for (const name of ["window", "readout", "letter", "title", "memory", "comms"]) {
      expect(stripDirectiveFences(`\`\`\`${name}\nX\n\`\`\``)).toBe("X\n");
    }
  });

  it("leaves fence-free prose untouched (inline code survives — not a fence)", () => {
    const prose = "She read the `mana_core` gauge and sighed.";
    expect(stripDirectiveFences(prose)).toBe(prose);
  });
});
