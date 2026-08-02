import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { describe, expect, it, vi } from "vitest";
import {
  VOICE_CHECKLIST_SYSTEM,
  VOICE_DIMENSIONS,
  type VoiceDimension,
  VoiceDimensionRead,
  type VoicePatterns,
  buildVoiceChecklistPrompt,
  composeVoicePressure,
  judgeVoice,
  measurableDimensions,
  voicePatterns,
} from "../voice";

// The checklist's ONLY model surface. Mocking callJudgment lets us inspect the
// prompt the Sakkan constructs WITHOUT a live call — the blindness law is
// asserted structurally, on what actually reaches the model (attribution.test.ts
// pattern).
vi.mock("@/lib/llm/calls", () => ({ callJudgment: vi.fn() }));
import { callJudgment } from "@/lib/llm/calls";
const mockJudgment = vi.mocked(callJudgment);

// Type-level guarantee (blindness law, §4.5 M2R4): VoicePatterns carries the
// four named-pattern lists and NOTHING else — no `treatment`/`dna`/`wanted`/
// `active` channel exists, so a dial cannot be smuggled into the prompt even by
// a caller that wants to. Add a field and keyof widens, breaking this line at
// compile time (pnpm typecheck) — the guard score.test.ts puts on ScoreOptions.
type AssertExact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const voicePatternsCarriesNoDial: AssertExact<keyof VoicePatterns, VoiceDimension> = true;

/**
 * Dial vocabulary that would leak what the story is SET to, past the axis
 * scorer's blindness. The voice judge sees the fingerprint by necessity (it IS
 * the checklist) — it must never see one of these. Word-bounded: the
 * fingerprint's own `dialogue_quirks` is not a leak of "dial".
 */
const DIAL_LEAK_TOKENS = [
  /\btreatments?\b/,
  /\bdna\b/,
  /\bdials?\b/,
  /\bpremise\b/,
  /\btargets?\b/,
  /\bwanted\b/,
  /\bcontract\b/,
];

/** A dial value rendered any way a prompt might render one: 7/10, 7 / 10, 0–10 scales. */
const DIAL_VALUE_PATTERNS = [/\b\d{1,2}\s*\/\s*10\b/, /\b0\s*[–-]\s*10\b/, /\b1\s*[–-]\s*10\b/];

const FINGERPRINT: VoicePatterns = {
  sentence_patterns: ["clipped, jazz-phrased", "the sentence lands a beat late"],
  structural_motifs: ["cold open", "smash cut to quiet"],
  dialogue_quirks: ["deflection as intimacy"],
  emotional_rhythm: ["long cool, sudden ache"],
};

const SAMPLE = "The neon guttered. Spike said nothing, and the elevator did the talking.";

describe("buildVoiceChecklistPrompt (pure, blind by construction)", () => {
  it("the VoicePatterns key set carries no dial channel (type-level pin)", () => {
    expect(voicePatternsCarriesNoDial).toBe(true);
    expect(VOICE_DIMENSIONS).toEqual([
      "sentence_patterns",
      "structural_motifs",
      "dialogue_quirks",
      "emotional_rhythm",
    ]);
  });

  it("presents every dimension's patterns AS A CHECKLIST, plus the sample verbatim", () => {
    const prompt = buildVoiceChecklistPrompt(FINGERPRINT, SAMPLE);
    for (const dim of VOICE_DIMENSIONS) {
      expect(prompt).toContain(dim);
      for (const pattern of FINGERPRINT[dim]) expect(prompt).toContain(pattern);
    }
    expect(prompt).toContain(SAMPLE);
    // Four dimensions asked for, on the voice scale — never a dial scale.
    expect(prompt).toContain("4 dimensions");
    expect(prompt).toContain("1–9");
  });

  it("BLINDNESS LAW: no dial vocabulary, no dial value, in the prompt or the system", () => {
    const surface = `${VOICE_CHECKLIST_SYSTEM}\n${buildVoiceChecklistPrompt(
      FINGERPRINT,
      SAMPLE,
    )}`.toLowerCase();
    for (const token of DIAL_LEAK_TOKENS) expect(surface).not.toMatch(token);
    for (const pattern of DIAL_VALUE_PATTERNS) expect(surface).not.toMatch(pattern);
    // The sentinel values a Bebop contract actually sets (darkness 7, comedy 3)
    // cannot render — buildVoiceChecklistPrompt has no channel to receive them.
    expect(surface).not.toContain("darkness");
    expect(surface).not.toContain("7/10");
    expect(surface).not.toContain("3/10");
  });

  it("omits a dimension with no named patterns — an empty checklist is unscoreable", () => {
    const partial: VoicePatterns = { ...FINGERPRINT, dialogue_quirks: [] };
    expect(measurableDimensions(partial)).toEqual([
      "sentence_patterns",
      "structural_motifs",
      "emotional_rhythm",
    ]);
    const prompt = buildVoiceChecklistPrompt(partial, SAMPLE);
    expect(prompt).not.toContain("dialogue_quirks");
    expect(prompt).toContain("3 dimensions");
  });

  it("voicePatterns lifts the four lists off author_voice and drops example_voice", () => {
    const patterns = voicePatterns({
      ...FINGERPRINT,
      example_voice: "Whatever happens, happens.",
    });
    expect(patterns).toEqual(FINGERPRINT);
    expect(buildVoiceChecklistPrompt(patterns, SAMPLE)).not.toContain("Whatever happens");
  });
});

describe("judgeVoice (judgment tier, STRUCTURED_SMALL budget)", () => {
  it("calls the traced judgment trio with the checklist prompt and the right budget", async () => {
    mockJudgment.mockReset();
    mockJudgment.mockResolvedValueOnce({
      dimensions: VOICE_DIMENSIONS.map((name, i) => ({
        name,
        score: 5 + i,
        evidence: `evidence for ${name}`,
      })),
    });

    const reads = await judgeVoice(DEV_TIER_SELECTION, {
      patterns: FINGERPRINT,
      sample: SAMPLE,
      campaignId: "c1",
      turnNumber: 16,
    });
    expect(reads).toHaveLength(4);
    expect(reads.map((r) => r.name)).toEqual([...VOICE_DIMENSIONS]);
    expect(reads[0]?.score).toBe(5);

    const opts = mockJudgment.mock.calls[0]?.[1];
    expect(opts?.name).toBe("sakkan_voice");
    expect(opts?.maxTokens).toBe(STRUCTURED_SMALL);
    expect(opts?.effort).toBe("low");
    expect(opts?.campaignId).toBe("c1");
    expect(opts?.turnNumber).toBe(16);
    // The schema is a flat array of dimension reads (strict output prefers flat
    // arrays over tuples). INTEGRALITY is schema-enforced; the 1–9 band is NOT
    // (M3 C2: the grammar strips ranges, so the band clamps in judgeVoice).
    expect(
      opts?.schema.safeParse({
        dimensions: [{ name: "sentence_patterns", score: 10, evidence: "x" }],
      })?.success,
    ).toBe(true);
    expect(
      opts?.schema.safeParse({
        dimensions: [{ name: "sentence_patterns", score: 4.5, evidence: "x" }],
      })?.success,
    ).toBe(false);

    const surface = `${opts?.system ?? ""}\n${opts?.prompt ?? ""}`.toLowerCase();
    for (const token of DIAL_LEAK_TOKENS) expect(surface).not.toMatch(token);
    expect(surface).toContain("clipped, jazz-phrased");
    expect(surface).toContain("the elevator did the talking");
  });

  it("drops names it never asked about and de-duplicates repeats", async () => {
    mockJudgment.mockReset();
    mockJudgment.mockResolvedValueOnce({
      dimensions: [
        { name: "sentence_patterns", score: 6, evidence: "first" },
        { name: "sentence_patterns", score: 2, evidence: "duplicate" },
        { name: "vibes", score: 9, evidence: "invented" },
      ],
    });
    const reads = await judgeVoice(DEV_TIER_SELECTION, {
      patterns: FINGERPRINT,
      sample: SAMPLE,
    });
    expect(reads).toEqual([{ name: "sentence_patterns", score: 6, evidence: "first" }]);
  });

  it("an empty fingerprint never reaches the model", async () => {
    mockJudgment.mockReset();
    const empty: VoicePatterns = {
      sentence_patterns: [],
      structural_motifs: [],
      dialogue_quirks: [],
      emotional_rhythm: [],
    };
    expect(await judgeVoice(DEV_TIER_SELECTION, { patterns: empty, sample: SAMPLE })).toEqual([]);
    expect(mockJudgment).not.toHaveBeenCalled();
  });
});

describe("composeVoicePressure (pure)", () => {
  it("names the dimension, quotes one of its patterns, anchors on the author's first sentence", () => {
    const line = composeVoicePressure(
      "dialogue_quirks",
      FINGERPRINT,
      "Whatever happens, happens. The rest is just weather.",
    );
    expect(line).toContain('"dialogue_quirks"');
    expect(line).toContain("weak two samples running");
    expect(line).toContain('"deflection as intimacy"');
    // The author's HAND — the first sentence only, not the whole paragraph.
    expect(line).toContain('"Whatever happens, happens."');
    expect(line).not.toContain("just weather");
  });

  it("degrades cleanly with no example_voice and an unknown dimension", () => {
    const line = composeVoicePressure("emotional_rhythm", FINGERPRINT, "   ");
    expect(line).toContain('"long cool, sudden ache"');
    expect(line).not.toContain("The author's hand");

    const unknown = composeVoicePressure("not_a_dimension", FINGERPRINT, "A line.");
    expect(unknown).toContain('"not_a_dimension"');
    expect(unknown).toContain('The author\'s hand: "A line."');
  });
});

/**
 * The M3 C2 bounds sweep. `judgeVoice`'s graceful drop covers unknown and
 * duplicated dimension NAMES — the whole sheet is parsed by callJudgment
 * before that filter ever runs, so a single out-of-band score used to kill all
 * four reads at once. `.int()` stays (grammar-native); the 1-9 band clamps.
 */
describe("judgeVoice numeric bounds (destroy-class: clamp, never reject)", () => {
  it("an out-of-band score clamps into 1-9 and the other dimensions survive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockJudgment.mockReset();
    mockJudgment.mockResolvedValueOnce({
      dimensions: VOICE_DIMENSIONS.map((name, i) => ({
        name,
        score: i === 0 ? 12 : i === 1 ? 0 : 6,
        evidence: `evidence for ${name}`,
      })),
    });
    const reads = await judgeVoice(DEV_TIER_SELECTION, { patterns: FINGERPRINT, sample: SAMPLE });
    expect(reads).toHaveLength(4);
    expect(reads[0]?.score).toBe(9);
    expect(reads[1]?.score).toBe(1);
    expect(reads[2]?.score).toBe(6);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an out-of-band read PARSES — the band is not a schema bound (M3 C2)", () => {
    expect(
      VoiceDimensionRead.safeParse({ name: "sentence_patterns", score: 40, evidence: "x" }).success,
    ).toBe(true);
    // Integrality IS grammar-native, so it stays enforced.
    expect(
      VoiceDimensionRead.safeParse({ name: "sentence_patterns", score: 4.5, evidence: "x" })
        .success,
    ).toBe(false);
  });
});
