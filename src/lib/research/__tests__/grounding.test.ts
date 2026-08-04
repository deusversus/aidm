import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimEvidence } from "../research";
import {
  type GroundingClaim,
  SYNTHESIS_FEEDS,
  groundProfile,
  renderClaims,
  sourceExcerptBlock,
  synthesizePowerSystem,
  synthesizeStatMapping,
} from "../synthesize";
import type { CanonicalPageType, WikiPage } from "../wiki";

/**
 * The excerpt selector (M3R3 C3, lesson L3). This block is what finally
 * reaches interpretTonal — the whole close of "the tonal read is recall BY
 * CONSTRUCTION" rests on it carrying the right pages, in the right order,
 * inside a budget the call can afford. The grounding pass deliberately does
 * NOT read it (see renderClaims below).
 */

const { callJudgmentMock } = vi.hoisted(() => ({ callJudgmentMock: vi.fn() }));
vi.mock("@/lib/llm/calls", () => ({ callJudgment: callJudgmentMock }));

function page(pageType: CanonicalPageType, title: string, text = "body"): WikiPage {
  return { title, pageType, text, url: `https://wiki/${title}`, origin: "wiki" };
}

describe("sourceExcerptBlock (M3R3 C3)", () => {
  it("no pages → empty string, so the caller stays on the ungrounded prompt", () => {
    expect(sourceExcerptBlock([])).toBe("");
  });

  it("orders by tonal priority: lore > arcs > characters > locations > factions > techniques > items", () => {
    const block = sourceExcerptBlock([
      page("items", "Sword"),
      page("techniques", "Ember Thread"),
      page("factions", "Ledger Houses"),
      page("locations", "Ashfall Reach"),
      page("characters", "Spike"),
      page("arcs", "The Long Fall"),
      page("lore", "The Ledger"),
    ]);
    const order = [...block.matchAll(/## \[(\w+)]/g)].map((m) => m[1]);
    expect(order).toEqual([
      "lore",
      "arcs",
      "characters",
      "locations",
      "factions",
      "techniques",
      "items",
    ]);
  });

  it("within a type the input order is kept — the scrape's own priority survives", () => {
    const block = sourceExcerptBlock([
      page("lore", "First"),
      page("lore", "Second"),
      page("lore", "Third"),
    ]);
    expect(block.indexOf("First")).toBeLessThan(block.indexOf("Second"));
    expect(block.indexOf("Second")).toBeLessThan(block.indexOf("Third"));
  });

  it("each page is clipped to its first 600 characters — the lead, not the trivia tables", () => {
    const block = sourceExcerptBlock([page("lore", "Long", `${"a".repeat(900)}TAIL`)]);
    expect(block).toContain("## [lore] Long");
    expect(block).not.toContain("TAIL");
    expect(block.replace("## [lore] Long\n", "")).toHaveLength(600);
  });

  it("caps at eight pages however deep the harvest ran", () => {
    const block = sourceExcerptBlock(
      Array.from({ length: 30 }, (_, i) => page("characters", `Char ${i}`)),
    );
    expect([...block.matchAll(/## \[/g)]).toHaveLength(8);
    expect(block).toContain("Char 0");
    expect(block).not.toContain("Char 8");
  });

  it("stays inside the block budget however fat the pages are", () => {
    // Long titles are what actually push the block past its ceiling: eight
    // 600-char clips alone sit under it by construction.
    const fat = Array.from({ length: 8 }, (_, i) =>
      page("lore", `Page ${i} ${"title-padding ".repeat(15)}`, "x".repeat(2_000)),
    );
    expect(sourceExcerptBlock(fat).length).toBeLessThanOrEqual(5_000);
  });

  it("a search page is excerpted like any other — one contract, both origins", () => {
    const searched: WikiPage = {
      title: "Test Show — stats (web research)",
      pageType: "lore",
      text: "The Ledger shows RANK and THREADCOUNT.",
      url: "https://src/stats",
      origin: "web_search",
    };
    expect(sourceExcerptBlock([searched])).toContain("THREADCOUNT");
  });
});

/**
 * PER-CLAIM EVIDENCE (M3R3 C3 audit). The first shape of this pass handed the
 * auditor ONE excerpt block — ranked for the tonal read, techniques sixth of
 * seven, hard-capped at eight pages — and then asked it whether the power
 * system was in there. On any harvest with eight or more lore/arc/character
 * pages the technique text was not in the block at all, so a wiki-sourced
 * power system met an auditor instructed "when in doubt, unsupported" and was
 * demoted by construction. Evidence now travels WITH its claim, and the
 * rendering is what makes that boundary visible to the model.
 */
describe("renderClaims (M3R3 C3)", () => {
  const claim = (key: string, evidence: string): GroundingClaim => ({
    key,
    claim: `the ${key} claim`,
    evidence,
  });

  it("renders each claim immediately followed by ITS OWN evidence", () => {
    expect(renderClaims([claim("power_system", "technique page text")])).toBe(
      "### CLAIM power_system\nthe power_system claim\n### EVIDENCE FOR power_system\ntechnique page text",
    );
  });

  it("two claims never share a section — each key's evidence sits under that key", () => {
    const block = renderClaims([
      claim("power_system", "EMBER-THREAD-TEXT"),
      claim("stat_mapping", "LEDGER-TEXT"),
    ]);
    const powerSection = block.slice(
      block.indexOf("### CLAIM power_system"),
      block.indexOf("### CLAIM stat_mapping"),
    );
    expect(powerSection).toContain("EMBER-THREAD-TEXT");
    expect(powerSection).not.toContain("LEDGER-TEXT");
    expect(block.slice(block.indexOf("### CLAIM stat_mapping"))).toContain("LEDGER-TEXT");
  });

  it("no claims → an empty block (the caller never buys the call in that shape)", () => {
    expect(renderClaims([])).toBe("");
  });
});

describe("groundProfile (M3R3 C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callJudgmentMock.mockResolvedValue({ verdicts: [] });
  });

  const sent = () => callJudgmentMock.mock.calls[0]?.[1] as { system: string; prompt: string };

  it("ships the per-claim block, and nothing that resembles a shared excerpt window", async () => {
    await groundProfile("Test Show", [
      { key: "power_system", claim: "Ember Threads burn memory", evidence: "TECHNIQUE-PAGE" },
      { key: "stat_mapping", claim: "The Ledger is canonical", evidence: "LORE-PAGE" },
    ]);
    const { prompt } = sent();
    expect(prompt).toContain("Work: Test Show");
    expect(prompt).toContain("### CLAIM power_system");
    expect(prompt).toContain("### EVIDENCE FOR power_system\nTECHNIQUE-PAGE");
    expect(prompt).toContain("### EVIDENCE FOR stat_mapping\nLORE-PAGE");
    // The pooled block is gone: there is no run-wide "evidence" section a
    // claim's own sources can be missing from.
    expect(prompt).not.toContain("FETCHED SOURCE EXCERPTS");
  });

  it("the system prompt fences each claim to its own evidence, and keeps doubt closed", async () => {
    await groundProfile("Test Show", [
      { key: "power_system", claim: "Ember Threads burn memory", evidence: "TECHNIQUE-PAGE" },
    ]);
    const { system } = sent();
    expect(system).toContain("EVIDENCE FOR that claim");
    expect(system).toContain("sources elsewhere in this run do not exist for it");
    expect(system).toContain("When in doubt, unsupported");
  });
});

/**
 * EVIDENCE PARITY (M3R3 C3 re-audit, finding [0]). Per-claim evidence closed
 * the shared-block hole and then reopened a smaller one: the claim was clipped
 * to 3 pages × 800 chars while synthesizePowerSystem had read 5 × 1,000, so a
 * power system synthesized from technique page 4 met an auditor told "when in
 * doubt, unsupported" against text that could not contain it — the same false
 * demotion, one layer down. Both sides now read SYNTHESIS_FEEDS, and these
 * tests import both sides so any drift breaks the build rather than a profile.
 */
describe("evidence parity with the synthesis feeds (M3R3 C3 re-audit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const feedPages = (count: number, chars: number, type: CanonicalPageType = "techniques") =>
    Array.from({ length: count }, (_, i) =>
      page(type, `Page ${i}`, `${"x".repeat(chars)}TAIL-${i}`),
    );

  it("claimEvidence covers exactly spec.pages × spec.chars, for every declared feed", () => {
    for (const spec of Object.values(SYNTHESIS_FEEDS)) {
      // Two pages deeper and 50 chars fatter than the spec, so both bounds bite.
      const pages = feedPages(spec.pages + 2, spec.chars + 50);
      const block = claimEvidence(pages, spec);
      // The LAST page inside the window is present; the first one outside is not.
      expect(block).toContain(`## Page ${spec.pages - 1}`);
      expect(block).not.toContain(`## Page ${spec.pages}`);
      // …and each page is clipped at exactly spec.chars: the tail marker sits
      // past the boundary and must not survive.
      expect(block).not.toContain("TAIL-");
      const bodies = block.split("\n\n").map((part) => part.split("\n")[1] ?? "");
      expect(bodies).toHaveLength(spec.pages);
      for (const body of bodies) expect(body).toHaveLength(spec.chars);
    }
  });

  it("the power_system claim reads EXACTLY what synthesizePowerSystem read", async () => {
    callJudgmentMock.mockResolvedValue({
      name: "Ember Threads",
      mechanics: "m",
      limitations: "l",
      tiers: [],
    });
    const spec = SYNTHESIS_FEEDS.power_system;
    const pages = feedPages(spec.pages + 2, spec.chars + 50);
    await synthesizePowerSystem(pages);
    const { prompt } = callJudgmentMock.mock.calls[0]?.[1] as { prompt: string };
    // Not "contains" — the two blocks are the same string, so an auditor
    // cannot be handed less than the synthesis saw.
    expect(prompt).toBe(claimEvidence(pages, spec));
  });

  it("the stat_mapping claim reads EXACTLY what synthesizeStatMapping read", async () => {
    callJudgmentMock.mockResolvedValue({
      has_canonical_stats: true,
      confidence: 95,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    });
    const spec = SYNTHESIS_FEEDS.stat_mapping;
    const pages = feedPages(spec.pages + 2, spec.chars + 50, "lore");
    await synthesizeStatMapping("Test Show", pages);
    const { prompt } = callJudgmentMock.mock.calls[0]?.[1] as { prompt: string };
    const evidence = claimEvidence(pages, spec);
    expect(prompt).toBe(`Title: Test Show\n\n${evidence}`);
  });
});
