import { CLASSIFY } from "@/lib/llm/budgets";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { describe, expect, it, vi } from "vitest";
import { type AttributionInput, attributeDrift, buildAttributionPrompt } from "../attribution";

// The attribution probe's ONLY model surface. Mocking callJudgment lets us
// inspect the prompt the Sakkan constructs WITHOUT a live call — the blind
// protocol is asserted structurally, on what actually reaches the model.
vi.mock("@/lib/llm/calls", () => ({ callJudgment: vi.fn() }));
import { callJudgment } from "@/lib/llm/calls";
const mockJudgment = vi.mocked(callJudgment);

// Type-level guarantee (blind protocol, §4.5): AttributionInput exposes NO
// channel for the values the story is aiming for — only the axis, the direction
// word, the player inputs, and narration tails. Add a `target`/`wanted`/
// `premise`/`active` field and keyof AttributionInput widens, breaking this line
// at compile time (pnpm typecheck) — the same guard score.test.ts puts on
// ScoreOptions.
type AssertExact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const attributionInputCarriesNoDial: AssertExact<
  keyof AttributionInput,
  "axis" | "direction" | "playerInputs" | "narrationTails"
> = true;

// The vocabulary that would leak what the story is REACHING for, past the blind
// band. None of it may appear in the constructed system+prompt (INTENT_SYSTEM-style).
const INTENT_LEAK_TOKENS = ["target", "active value", "premise", "dial", "wanted", "contract"];

const INPUT: AttributionInput = {
  axis: "continuity",
  direction: "higher",
  playerInputs: [
    "I keep the same bounty thread going all night — no scene breaks, just one long evening.",
    "Pick up exactly where we left off; I don't want to jump anywhere.",
  ],
  narrationTails: ["…the dock lights held steady over the same slick of water."],
};

describe("buildAttributionPrompt (pure, blind by construction)", () => {
  it("the AttributionInput key set carries no dial channel (type-level pin)", () => {
    expect(attributionInputCarriesNoDial).toBe(true);
  });

  it("carries the axis, the direction word, and the player inputs — verbatim", () => {
    const prompt = buildAttributionPrompt(INPUT);
    expect(prompt).toContain("continuity");
    expect(prompt).toContain("higher");
    expect(prompt).toContain("one long evening");
    expect(prompt).toContain("Pick up exactly where we left off");
    // The player inputs are foregrounded, not the narration.
    expect(prompt.toLowerCase()).toContain("player inputs");
  });

  it("leaks NO premise/dial/target value (the blind-protocol pin)", () => {
    // Sentinel dial values the story might be aiming for. buildAttributionPrompt
    // cannot even receive them (no channel exists), so they can never render.
    const prompt = buildAttributionPrompt(INPUT).toLowerCase();
    for (const token of INTENT_LEAK_TOKENS) {
      expect(prompt).not.toContain(token);
    }
    // Neither the premise's set value nor any numeric target appears.
    expect(prompt).not.toMatch(/\b(3|7)\s*\/\s*10\b/);
  });
});

describe("attributeDrift (judgment tier, CLASSIFY budget)", () => {
  it("calls the traced judgment trio with the blind prompt and the right budget/schema", async () => {
    mockJudgment.mockResolvedValueOnce({
      driver: "player_driven",
      evidence: "the player kept it one evening",
    });
    const result = await attributeDrift(DEV_TIER_SELECTION, {
      ...INPUT,
      campaignId: "c1",
      turnNumber: 16,
    });
    expect(result).toEqual({ driver: "player_driven", evidence: "the player kept it one evening" });

    const opts = mockJudgment.mock.calls[0]?.[1];
    expect(opts?.name).toBe("sakkan_attribution");
    expect(opts?.maxTokens).toBe(CLASSIFY);
    expect(opts?.effort).toBe("low");
    expect(opts?.campaignId).toBe("c1");
    expect(opts?.turnNumber).toBe(16);
    // The system+prompt the model actually sees stays blind.
    const surface = `${opts?.system ?? ""}\n${opts?.prompt ?? ""}`.toLowerCase();
    for (const token of INTENT_LEAK_TOKENS) {
      expect(surface).not.toContain(token);
    }
    // And it does carry the player-facing evidence channel.
    expect(surface).toContain("player inputs");
    expect(surface).toContain("continuity");
  });
});
