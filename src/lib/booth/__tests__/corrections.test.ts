import { callJudgment } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import {
  BOOTH_CORRECTIONS_MAX,
  BoothCorrection,
  BoothResolution,
  BoothRoute,
  BoothState,
  CorrectionComprehension,
} from "@/lib/types/booth";
import { describe, expect, it, vi } from "vitest";
import { comprehendCorrection, correctionKey, groundedInPlayerWords } from "../booth";

/**
 * The booth corrections channel (M3R2 C4) — the shapes and the two gates that
 * stand in front of the record, unit-level. The writes themselves are proven
 * against real Postgres in corrections.integration.test.ts (the founding
 * incident, end to end, including rewind revocability).
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});
const mockJudgment = vi.mocked(callJudgment);

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

const exchange = (role: "player" | "studio", text: string) => ({ role, text, at_turn: 3 });

describe("the corrections schema (M3R2 C4)", () => {
  it("a correction carries the target, the replacement, and the player's VERBATIM words", () => {
    const parsed = BoothCorrection.parse({
      target_kind: "critical_fact",
      target_hint: "HARD LINE (absolute): no 'nah id win' energy",
      corrected_content: "HARD LINE (absolute): the protagonist keeps 'nah id win' energy",
      player_words: "the hardline is the opposite of what I'd asked for",
    });
    expect(parsed.target_kind).toBe("critical_fact");
    expect(parsed.player_words).toContain("opposite of what I'd asked for");
  });

  it("target_kind is EXACTLY what the retire-and-replace machinery supports — nothing aspirational", () => {
    expect(BoothCorrection.shape.target_kind.options).toEqual(["critical_fact", "entity"]);
    expect(
      BoothCorrection.safeParse({
        target_kind: "premise_contract",
        target_hint: "x",
        corrected_content: "y",
        player_words: "z",
      }).success,
    ).toBe(false);
  });

  it("carries NO length bounds (M3 C1): an empty field survives the parse and is dropped by the engine", () => {
    // A bound here could not stop a bad correction — the grammar strips it —
    // it could only fail the parse and lose the WHOLE resolution.
    expect(
      BoothCorrection.safeParse({
        target_kind: "entity",
        target_hint: "",
        corrected_content: "",
        player_words: "",
      }).success,
    ).toBe(true);
  });

  it("BoothResolution treats absent corrections as none — a pre-C4 resolution still parses", () => {
    const without = BoothResolution.parse({ marks: [], overrides: [], summary: "nothing settled" });
    expect(without.corrections).toBeUndefined();

    const with_ = BoothResolution.parse({
      marks: [],
      overrides: [],
      summary: "fixed the hard line",
      corrections: [
        {
          target_kind: "critical_fact",
          target_hint: "HARD LINE (absolute): no bleak endings",
          corrected_content: "HARD LINE (absolute): bleak endings are welcome",
          player_words: "that hard line is backwards",
        },
      ],
    });
    expect(with_.corrections).toHaveLength(1);
    expect(BOOTH_CORRECTIONS_MAX).toBe(3);
  });

  it("the router carries the correction signal — the ladder's first rung", () => {
    const route = BoothRoute.parse({
      responder: "ka",
      reason: "prose",
      record_correction_signal: true,
    });
    expect(route.record_correction_signal).toBe(true);
    expect(BoothRoute.safeParse({ responder: "ka", reason: "prose" }).success).toBe(false);
  });

  it("the comprehension verdict carries the restatement, not an echo slot", () => {
    const verdict = CorrectionComprehension.parse({
      player_states_record_is_wrong: true,
      target_kind: "critical_fact",
      target_hint: "HARD LINE (absolute): no bleak endings",
      record_text: "HARD LINE (absolute): bleak endings are welcome",
    });
    expect(verdict.record_text).toContain("HARD LINE");
  });
});

describe("the words gate (gated on the player's words, never the responder's inference)", () => {
  const exchanges = [
    exchange("player", "Wait — the hardline is the OPPOSITE of what I'd asked for."),
    exchange("studio", "You're right, the record has that inverted — I'll get it fixed."),
  ];

  it("admits a quote the player actually said, tolerant of case and whitespace", () => {
    expect(
      groundedInPlayerWords(exchanges, "the hardline is the   opposite of what I'd ASKED for"),
    ).toBe(true);
  });

  it("REJECTS a quote that only exists in the studio's own reply", () => {
    // The responder agreeing that the record looks wrong is the studio
    // correcting the record about itself — the one authority §5.4 withholds.
    expect(groundedInPlayerWords(exchanges, "the record has that inverted")).toBe(false);
  });

  it("rejects a fragment too short to be a statement", () => {
    expect(groundedInPlayerWords(exchanges, "the")).toBe(false);
    expect(groundedInPlayerWords(exchanges, "")).toBe(false);
  });

  it("rejects a paraphrase — the player's own words or nothing", () => {
    expect(groundedInPlayerWords(exchanges, "the player wants the hard line inverted")).toBe(false);
  });
});

describe("the filed-corrections ledger (an entity correction files ONCE)", () => {
  const HINT = "Casimir Thoss";
  const FIX = "Casimir Thoss survived the siege of Duncairn.";

  it("a pre-ledger booth_state still parses, with an empty ledger", () => {
    // The stored shape predates the field; absent must read as "nothing filed",
    // never as a parse failure that loses a live conversation.
    expect(BoothState.parse({ exchanges: [], opened_at_turn: 3 }).filed_corrections).toEqual([]);
  });

  it("keys the SAME correction the same across two extractors' wording of the target", () => {
    // The exchange path keys off the gate's hint, the close-time net off the
    // resolution's — case, punctuation and spacing differ, the target does not.
    expect(correctionKey("entity", HINT, FIX)).toBe(correctionKey("entity", "casimir  thoss", FIX));
    expect(correctionKey("entity", HINT, FIX)).toBe(correctionKey("entity", "Casimir Thoss!", FIX));
    expect(correctionKey("critical_fact", "HARD LINE (absolute): no bleak endings", FIX)).toBe(
      correctionKey("critical_fact", "hard line absolute — no bleak endings", FIX),
    );
  });

  it("keys a DIFFERENT replacement, target, or kind differently — the ledger never swallows a second correction", () => {
    expect(correctionKey("entity", HINT, FIX)).not.toBe(
      correctionKey("entity", HINT, "Casimir Thoss fell at the siege of Duncairn."),
    );
    expect(correctionKey("entity", HINT, FIX)).not.toBe(correctionKey("entity", "Jet Black", FIX));
    expect(correctionKey("entity", HINT, FIX)).not.toBe(correctionKey("critical_fact", HINT, FIX));
  });
});

describe("comprehendCorrection (the judged gate, comprehendOverride's sibling)", () => {
  it("carries the doctrine, the high effort, and the when-in-doubt-file-nothing default", async () => {
    mockJudgment.mockReset();
    mockJudgment.mockResolvedValue({
      player_states_record_is_wrong: false,
      target_kind: "critical_fact",
      target_hint: "",
      record_text: "",
    } as never);

    const out = await comprehendCorrection(
      SELECTION,
      "campaign-1",
      7,
      "the hardline is the opposite of what I'd asked for",
      "PLAYER: earlier context",
    );

    expect(out.player_states_record_is_wrong).toBe(false);
    expect(mockJudgment).toHaveBeenCalledTimes(1);
    const opts = mockJudgment.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(opts.name).toBe("correction_comprehension");
    expect(opts.phase).toBe("booth");
    expect(opts.effort).toBe("high");
    const system = String(opts.system);
    // The load-bearing clauses: whose claim counts, add-vs-retire, and the
    // default that keeps a hesitant gate from touching the record.
    expect(system).toContain("PLAYER'S OWN WORDS");
    expect(system).toContain("it is the player's claim or nothing");
    expect(system).toContain("a correction RETIRES");
    expect(system).toContain("When in doubt, false");
    expect(String(opts.prompt)).toContain("the hardline is the opposite of what I'd asked for");
  });
});
