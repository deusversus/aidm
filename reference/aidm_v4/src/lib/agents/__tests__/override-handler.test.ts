import { createMockAnthropic as fakeAnthropic } from "@/lib/llm/mock/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Unified mock Anthropic stub aliased to preserve call-site diff. Phase E.

describe("handleOverride", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("classifies an /override NPC_PROTECTION command", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          mode: "override",
          category: "NPC_PROTECTION",
          value: "Lloyd cannot die",
          scope: "campaign",
          conflicts_with: [],
          ack_phrasing: "Noted. Lloyd will reach the end of this story alive.",
        }),
      },
    ]);
    const result = await handleOverride(
      { command: "/override Lloyd cannot die", prior_overrides: [] },
      { anthropic },
    );
    expect(result.mode).toBe("override");
    expect(result.category).toBe("NPC_PROTECTION");
    expect(result.value).toBe("Lloyd cannot die");
  });

  it("classifies a /meta calibration with null category", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          mode: "meta",
          category: null,
          value: "less torture, more mystery",
          scope: "campaign",
          conflicts_with: [],
          ack_phrasing: "Heard. I'll lean that way.",
        }),
      },
    ]);
    const result = await handleOverride(
      { command: "/meta less torture, more mystery", prior_overrides: [] },
      { anthropic },
    );
    expect(result.mode).toBe("meta");
    expect(result.category).toBeNull();
  });

  it("surfaces conflict with prior overrides", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      {
        text: JSON.stringify({
          mode: "override",
          category: "CONTENT_CONSTRAINT",
          value: "no explicit violence",
          scope: "campaign",
          conflicts_with: ["o-prev-1"],
          ack_phrasing: "Noted. Replacing the prior tone constraint.",
        }),
      },
    ]);
    const result = await handleOverride(
      {
        command: "/override no explicit violence",
        prior_overrides: [
          {
            id: "o-prev-1",
            category: "CONTENT_CONSTRAINT",
            value: "more visceral combat",
            scope: "campaign",
          },
        ],
      },
      { anthropic },
    );
    expect(result.conflicts_with).toContain("o-prev-1");
  });

  it("retries once on malformed JSON then recovers", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      { text: "not json" },
      {
        text: JSON.stringify({
          mode: "meta",
          category: null,
          value: "lighter",
          scope: "campaign",
          conflicts_with: [],
          ack_phrasing: "ok",
        }),
      },
    ]);
    const result = await handleOverride(
      { command: "/meta lighter", prior_overrides: [] },
      { anthropic },
    );
    expect(result.mode).toBe("meta");
  });

  it("fallback preserves the command as a NARRATIVE_DEMAND override when /override prefix present", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      { error: new Error("upstream") },
      { error: new Error("upstream") },
    ]);
    const result = await handleOverride(
      { command: "/override make sure Aria returns in the finale", prior_overrides: [] },
      { anthropic },
    );
    expect(result.mode).toBe("override");
    expect(result.category).toBe("NARRATIVE_DEMAND");
    expect(result.value).toBe("make sure Aria returns in the finale");
  });

  it("fallback classifies /meta command as meta with null category", async () => {
    const { handleOverride } = await import("../override-handler");
    const anthropic = fakeAnthropic([
      { error: new Error("upstream") },
      { error: new Error("upstream") },
    ]);
    const result = await handleOverride(
      { command: "/meta bring Faye back into the spotlight", prior_overrides: [] },
      { anthropic },
    );
    expect(result.mode).toBe("meta");
    expect(result.category).toBeNull();
    expect(result.value).toContain("Faye");
  });
});
