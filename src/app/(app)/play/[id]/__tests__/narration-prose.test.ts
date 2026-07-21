import type { DirectiveGrant } from "@/lib/types/premise";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDirectiveWarnings } from "../directives";
import { NarrationProse } from "../narration-prose";

/**
 * NarrationProse's directive handling, rendered through the REAL react-markdown
 * pipeline (renderToStaticMarkup — no DOM needed, so it runs in the node env).
 * This is the streaming-shaped test the M3-DG plan calls for: an unclosed fence
 * mid-stream must render as a FORMING device block, never as literal backticks.
 */

const html = (text: string, directives: DirectiveGrant[] = [], streaming = false) =>
  renderToStaticMarkup(createElement(NarrationProse, { text, directives, streaming }));

beforeEach(() => {
  // Suppress the once-per-name fallback log; the count itself is asserted in
  // directives.test.ts. Reset so warn state never leaks between cases.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetDirectiveWarnings();
});
afterEach(() => vi.restoreAllMocks());

describe("NarrationProse — M3-DG directives", () => {
  it("a granted device renders its styled chrome + skin, never the fallback", () => {
    const out = html("```readout\nLILITH: THREAT CRITICAL\n```", [
      { name: "readout", skin: "the machine" },
    ]);
    expect(out).toContain('data-device="readout"');
    expect(out).toContain('data-skin="the machine"');
    expect(out).toContain("LILITH: THREAT CRITICAL");
    expect(out).not.toContain('data-device="fallback"');
    // The fence markers never reach the DOM.
    expect(out).not.toContain("```");
  });

  it("an ungranted (non-memory) device degrades to the offset fallback", () => {
    const out = html("```window\nHP 40/100\n```", []);
    expect(out).toContain('data-device="fallback"');
    expect(out).toContain("HP 40/100");
  });

  it("memory is UNIVERSAL — ungranted still renders its neutral marking", () => {
    const out = html("```memory\nyears ago, it rained here\n```", []);
    expect(out).toContain('data-device="memory"');
    expect(out).not.toContain('data-device="fallback"');
    expect(out).toContain("years ago, it rained here");
    // No skin was granted → no data-skin, neutral chrome.
    expect(out).not.toContain("data-skin");
  });

  it("STREAMING SAFETY: an unclosed fence renders as a forming device, not garbage", () => {
    // Mid-stream: the closing ``` has not arrived yet.
    const out = html("The alarm screamed.\n\n```readout\nLILITH: scanning the", [
      { name: "readout", skin: "the machine" },
    ]);
    // CommonMark closes an unclosed fence at end-of-input, so it is a real
    // readout block — the partial content is shown, no literal backticks leak.
    expect(out).toContain('data-device="readout"');
    expect(out).toContain("LILITH: scanning the");
    expect(out).not.toContain("```");
  });

  it("a bare ``` fence (no info string) stays a generic monospace block", () => {
    const out = html("prose before\n\n```\nplain code\n```");
    expect(out).toContain("<pre");
    expect(out).not.toContain("data-device");
  });

  it("inline `code` is untouched by the directive seam", () => {
    const out = html("a `mana_core` reading");
    expect(out).toContain("<code");
    expect(out).not.toContain("data-device");
    expect(out).toContain("mana_core");
  });

  it("an unknown fence name degrades to the offset fallback", () => {
    const out = html("```python\nprint(1)\n```", [{ name: "readout", skin: "x" }]);
    expect(out).toContain('data-device="fallback"');
  });

  it("plain prose with no fences renders unchanged (no directive chrome)", () => {
    const out = html("She stood still. The lamp ticked.", [{ name: "readout", skin: "x" }]);
    expect(out).not.toContain("data-device");
    expect(out).toContain("She stood still.");
  });
});
