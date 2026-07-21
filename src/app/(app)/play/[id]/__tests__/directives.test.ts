import type { DirectiveGrant } from "@/lib/types/premise";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTIVE_CHROME,
  DIRECTIVE_NAMES,
  __resetDirectiveWarnings,
  directiveFenceName,
  resolveDirective,
} from "../directives";

/**
 * The M3-DG directive registry (pure half). The rendered chrome is proven in
 * narration-prose.test.ts; here we pin the resolution LAW: granted → styled,
 * ungranted `memory` → neutral (universal marking), everything else → offset
 * fallback logged once per name.
 */

afterEach(() => __resetDirectiveWarnings());

describe("directiveFenceName", () => {
  it("reads react-markdown's language class; null for a bare fence", () => {
    expect(directiveFenceName("language-readout")).toBe("readout");
    expect(directiveFenceName("lang before language-window after")).toBe("window");
    expect(directiveFenceName(undefined)).toBeNull();
    expect(directiveFenceName("")).toBeNull();
    // A generic code block (no info string) has no language class.
    expect(directiveFenceName("some-other-class")).toBeNull();
  });
});

describe("resolveDirective (M3-DG law)", () => {
  const granted: DirectiveGrant[] = [
    { name: "readout", skin: "Lilith's machine" },
    { name: "memory", skin: "a sepia flashback" },
  ];

  it("a granted device resolves to styled chrome carrying its skin", () => {
    expect(resolveDirective("readout", granted)).toEqual({
      mode: "styled",
      name: "readout",
      skin: "Lilith's machine",
    });
  });

  it("granted memory carries its skin (styled), not the neutral marking", () => {
    expect(resolveDirective("memory", granted)).toEqual({
      mode: "styled",
      name: "memory",
      skin: "a sepia flashback",
    });
  });

  it("UNGRANTED memory is UNIVERSAL — a neutral marking, never the fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDirective("memory", [])).toEqual({ mode: "neutral", name: "memory" });
    // The universal marking is not a defect — it must not log.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an ungranted (non-memory) device degrades to the offset fallback, logged once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDirective("window", [])).toEqual({ mode: "fallback", name: "window" });
    // Once per NAME, not per render.
    resolveDirective("window", []);
    resolveDirective("window", []);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("an unknown fence name degrades to the offset fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDirective("python", [])).toEqual({ mode: "fallback", name: "python" });
    warn.mockRestore();
  });
});

describe("DIRECTIVE_CHROME", () => {
  it("every device plus the fallback maps to a distinct, non-empty class string", () => {
    const names = [...DIRECTIVE_NAMES, "fallback"];
    const classes = names.map((n) => DIRECTIVE_CHROME[n as keyof typeof DIRECTIVE_CHROME]);
    for (const c of classes) expect(c.length).toBeGreaterThan(0);
    expect(new Set(classes).size).toBe(classes.length);
  });
});
