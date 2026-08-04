import { describe, expect, it } from "vitest";
import { KNOWLEDGE_CUTOFF_YEAR, buildFieldSources, deriveTrust, mechanicsImplied } from "../trust";

/**
 * The trust derivation (M3R3 C1). The founding case is pinned exactly: the
 * profile that shipped at asserted-confidence 90 with pagesFetched 0 and
 * "scrape is not viable" in its own notes must derive THIN here, with its
 * gaps named — a LitRPG title, post-cutoff adaptation, zero sources.
 */

const base = {
  startYear: 2020,
  pagesFetched: 0,
  contentChars: 0,
  sourcesConsulted: ["anilist"],
  powerSystemPresent: false,
  powerSystemFromPages: false,
  statsCanonical: false,
  statConfidence: 0,
  voiceQuoteCharacters: 0,
  mechanicsImplied: false,
  method: "anilist_only" as const,
  fieldSources: {},
  fieldPages: {},
};

describe("deriveTrust (M3R3 C1)", () => {
  it("THE FOUNDING CASE: post-cutoff LitRPG, zero pages → thin, with every gap named", () => {
    const t = deriveTrust({
      ...base,
      startYear: KNOWLEDGE_CUTOFF_YEAR,
      mechanicsImplied: true,
    });
    // 20 + 15 (anilist) − 15 (mechanics gap) − 20 (post-cutoff recall) = 0 → clamped 5.
    expect(t.derived_confidence).toBe(5);
    expect(t.post_cutoff).toBe(true);
    expect(t.coverage_gaps.join(" | ")).toContain("zero source pages");
    expect(t.coverage_gaps.join(" | ")).toContain("power system");
    expect(t.coverage_gaps.join(" | ")).toContain("knowledge cutoff");
    expect(t.coverage_gaps.join(" | ")).toContain("no character quotes");
  });

  it("a rich scrape derives high: pages, grounded power system, canonical stats, real quotes", () => {
    const t = deriveTrust({
      ...base,
      pagesFetched: 40,
      contentChars: 200_000,
      powerSystemPresent: true,
      powerSystemFromPages: true,
      statsCanonical: true,
      statConfidence: 85,
      voiceQuoteCharacters: 4,
      method: "api_wiki",
    });
    // 20 + 15 + 30 + 10 + 5 + 10 = 90.
    expect(t.derived_confidence).toBe(90);
    expect(t.post_cutoff).toBe(false);
    expect(t.coverage_gaps).toHaveLength(0);
  });

  it("a mundane pre-cutoff title without mechanics carries no mechanics penalty", () => {
    const t = deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      voiceQuoteCharacters: 2,
    });
    // 20 + 15 + 30 + 10 = 75; gaps: none of the penalty class.
    expect(t.derived_confidence).toBe(75);
    expect(t.coverage_gaps.some((g) => g.includes("power system"))).toBe(false);
  });

  it("recall-only power system earns half the grounded credit", () => {
    const grounded = deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      powerSystemPresent: true,
      powerSystemFromPages: true,
      voiceQuoteCharacters: 1,
    });
    const recall = deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      powerSystemPresent: true,
      powerSystemFromPages: false,
      voiceQuoteCharacters: 1,
    });
    expect(grounded.derived_confidence - recall.derived_confidence).toBe(5);
  });

  it("post-cutoff WITH rich sources is noted but not punished — the sources carry it", () => {
    const t = deriveTrust({
      ...base,
      startYear: KNOWLEDGE_CUTOFF_YEAR,
      pagesFetched: 20,
      contentChars: 80_000,
      voiceQuoteCharacters: 2,
    });
    expect(t.post_cutoff).toBe(true);
    expect(t.coverage_gaps.some((g) => g.includes("knowledge cutoff"))).toBe(false);
    expect(t.derived_confidence).toBe(75);
  });

  it("ten stubs do not buy the rich-scrape credit — page count without text is shallow", () => {
    const t = deriveTrust({
      ...base,
      pagesFetched: 12,
      contentChars: 700,
      voiceQuoteCharacters: 2,
    });
    // 20 + 15 + 15 (thin tier, NOT 30) + 10 = 60, with the stub gap named.
    expect(t.derived_confidence).toBe(60);
    expect(t.coverage_gaps.join(" | ")).toContain("stubs");
  });

  it("post-cutoff + stub wiki cannot escape the recency demotion through page count", () => {
    const t = deriveTrust({
      ...base,
      startYear: KNOWLEDGE_CUTOFF_YEAR,
      pagesFetched: 12,
      contentChars: 700,
    });
    // 20 + 15 + 15 − 10 (thin post-cutoff) = 40, quotes gap on top.
    expect(t.derived_confidence).toBe(40);
    expect(t.post_cutoff).toBe(true);
    expect(t.coverage_gaps.join(" | ")).toContain("thin");
  });

  it("M3R3 C2: a Level B identity is verified by CITATION — real, but not AniList's credit", () => {
    // Same coverage, same everything: only the identity term moves.
    const api = deriveTrust({ ...base });
    const web = deriveTrust({ ...base, method: "web_search" });
    expect(api.derived_confidence).toBe(35); // 20 + 15 (AniList row)
    expect(web.derived_confidence).toBe(30); // 20 + 10 (citation)
  });
});

describe("buildFieldSources (M3R3 C1, source-typed at C2)", () => {
  it("the api_thin trap: wiki found, zero pages → NOTHING is labeled wiki_page", () => {
    const fs = buildFieldSources({
      identityOrigin: "anilist",
      settingSource: null,
      statMappingSource: null,
      powerSystemSource: null,
      voiceSource: null,
    });
    expect(fs.world_setting).toBe("anilist");
    expect(fs.stat_mapping).toBeUndefined();
    expect(fs.power_system).toBeUndefined();
    expect(fs.voice_cards).toBe("model_recall");
    expect(Object.values(fs)).not.toContain("wiki_page");
    expect(Object.values(fs)).not.toContain("web_search");
  });

  it("grounded content earns the wiki_page label — per field, on content", () => {
    const fs = buildFieldSources({
      identityOrigin: "anilist",
      settingSource: "wiki",
      statMappingSource: "wiki",
      powerSystemSource: "wiki",
      voiceSource: "wiki",
    });
    expect(fs.world_setting).toBe("wiki_page");
    expect(fs.stat_mapping).toBe("wiki_page");
    expect(fs.power_system).toBe("wiki_page");
    expect(fs.voice_cards).toBe("wiki_page");
  });

  it("M3R3 C2: a search-fed organ says web_search — it never borrows wiki's label", () => {
    const fs = buildFieldSources({
      identityOrigin: "anilist",
      settingSource: "search",
      statMappingSource: "search",
      powerSystemSource: "wiki",
      voiceSource: null,
    });
    expect(fs.world_setting).toBe("web_search");
    expect(fs.stat_mapping).toBe("web_search");
    // A hybrid profile labels per organ: the scraped one stays wiki_page.
    expect(fs.power_system).toBe("wiki_page");
    expect(fs.voice_cards).toBe("model_recall");
  });

  it("LEVEL B: an ungrounded world_setting names the WEB identity that fed its genre", () => {
    const fs = buildFieldSources({
      identityOrigin: "web_search",
      settingSource: null,
      statMappingSource: null,
      powerSystemSource: null,
      voiceSource: null,
    });
    // The same record's sources_consulted omits anilist deliberately — the
    // field label must not contradict it.
    expect(fs.world_setting).toBe("web_search");
    // An AniList-backed profile in the identical coverage shape still says
    // anilist: the genre list really did come from the row.
    expect(
      buildFieldSources({
        identityOrigin: "anilist",
        settingSource: null,
        statMappingSource: null,
        powerSystemSource: null,
        voiceSource: null,
      }).world_setting,
    ).toBe("anilist");
  });

  it("tonal fields are model_recall in every shape until C3 grounds them", () => {
    for (const source of ["wiki", "search", null] as const) {
      const fs = buildFieldSources({
        identityOrigin: "anilist",
        settingSource: source,
        statMappingSource: source,
        powerSystemSource: source,
        voiceSource: source,
      });
      expect(fs.canonical_dna).toBe("model_recall");
      expect(fs.author_voice).toBe("model_recall");
      expect(fs.director_personality).toBe("model_recall");
    }
  });
});

describe("mechanicsImplied", () => {
  it("catches the LitRPG/dungeon/cultivation family across genres and tags", () => {
    expect(mechanicsImplied(["Fantasy"], ["LitRPG"])).toBe(true);
    expect(mechanicsImplied(["Action"], ["Dungeon Crawling"])).toBe(true);
    expect(mechanicsImplied([], ["Cultivation"])).toBe(true);
    expect(mechanicsImplied(["Fantasy", "Action"], ["Female Protagonist"])).toBe(false);
  });
});
