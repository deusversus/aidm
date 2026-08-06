import { describe, expect, it } from "vitest";
import {
  GROUNDABLE_TEXT_FLOOR_CHARS,
  KNOWLEDGE_CUTOFF_YEAR,
  buildFieldSources,
  coverageGates,
  deriveTrust,
  mechanicsImplied,
} from "../trust";

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
      tonalSource: null,
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
      tonalSource: "wiki",
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
      tonalSource: "search",
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
      tonalSource: null,
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
        tonalSource: null,
        settingSource: null,
        statMappingSource: null,
        powerSystemSource: null,
        voiceSource: null,
      }).world_setting,
    ).toBe("anilist");
  });
});

/**
 * L3's close (M3R3 C3): the tonal read used to be recall BY CONSTRUCTION —
 * interpretTonal saw only the AniList synopsis. Now it reads the harvest, and
 * the labels follow the pages. Group B does NOT follow: the narrative call
 * reads the assembled profile, a synthesis of syntheses, so no page can
 * honestly be named as its source.
 */
describe("buildFieldSources tonal grounding (M3R3 C3, L3)", () => {
  const GROUP_A = [
    "canonical_dna",
    "canonical_composition",
    "storytelling_tropes",
    "visual_style",
    "combat_style",
    "power_distribution",
  ];
  const GROUP_B = ["director_personality", "author_voice", "cast_depth_posture"];

  const build = (tonalSource: "wiki" | "search" | null) =>
    buildFieldSources({
      identityOrigin: "anilist",
      tonalSource,
      settingSource: null,
      statMappingSource: null,
      powerSystemSource: null,
      voiceSource: null,
    });

  it("wiki pages fed the tonal read → the six interpreted fields say wiki_page", () => {
    const fs = build("wiki");
    for (const field of GROUP_A) expect(fs[field]).toBe("wiki_page");
  });

  it("a search-fed tonal read says web_search — it never borrows the wiki label", () => {
    const fs = build("search");
    for (const field of GROUP_A) expect(fs[field]).toBe("web_search");
  });

  it("no pages reached interpretTonal → the tonal read is recall, and says so", () => {
    const fs = build(null);
    for (const field of GROUP_A) expect(fs[field]).toBe("model_recall");
  });

  it("GROUP B stays model_recall in every shape — it reads the profile, not the sources", () => {
    for (const source of ["wiki", "search", null] as const) {
      const fs = build(source);
      for (const field of GROUP_B) expect(fs[field]).toBe("model_recall");
    }
  });
});

/**
 * The coverage gates (M3R3 C3, lesson L4): v3 had ONE hard gate and v5 had
 * none — a LitRPG with power_system null, zero quotes and stat-confidence 0
 * parsed clean and compiled into a campaign. These fire on the shapes that
 * are presumptively broken, and MARK rather than throw.
 */
describe("coverageGates (M3R3 C3, L4)", () => {
  const clean = {
    mechanicsImplied: false,
    powerSystemPresent: false,
    statsCanonical: false,
    contentChars: 40_000,
    pagesFetched: 30,
  };

  it("a thin-but-honest profile is NOT defective — thin is a gap, not a defect", () => {
    const g = coverageGates(clean);
    expect(g.defective).toBe(false);
    expect(g.defects).toHaveLength(0);
  });

  it("mechanics implied, no power system → the KA would improvise §4 constraints", () => {
    const g = coverageGates({ ...clean, mechanicsImplied: true });
    expect(g.defective).toBe(true);
    expect(g.defects).toHaveLength(1);
    expect(g.defects[0]).toContain("DEFECT: genre/tags imply a game-mechanics power system");
  });

  it("mechanics IP WITH a power system but no canonical stats → invented status windows", () => {
    const g = coverageGates({ ...clean, mechanicsImplied: true, powerSystemPresent: true });
    expect(g.defective).toBe(true);
    expect(g.defects).toHaveLength(1);
    expect(g.defects[0]).toContain("without a canonical stat mapping");
  });

  it("a mechanics IP with BOTH organs clears the mechanics gates", () => {
    const g = coverageGates({
      ...clean,
      mechanicsImplied: true,
      powerSystemPresent: true,
      statsCanonical: true,
    });
    expect(g.defective).toBe(false);
  });

  it("v3's lore floor, carried: under 200 characters of source text is recall in a trench coat", () => {
    const g = coverageGates({ ...clean, contentChars: 0, pagesFetched: 0 });
    expect(g.defective).toBe(true);
    expect(g.defects[0]).toContain("groundable source text");
  });

  it("the floor is exact: 199 fires, 200 does not", () => {
    expect(
      coverageGates({ ...clean, contentChars: GROUNDABLE_TEXT_FLOOR_CHARS - 1 }).defective,
    ).toBe(true);
    expect(coverageGates({ ...clean, contentChars: GROUNDABLE_TEXT_FLOOR_CHARS }).defective).toBe(
      false,
    );
  });

  it("the founding case trips two gates at once, both named", () => {
    const g = coverageGates({
      mechanicsImplied: true,
      powerSystemPresent: false,
      statsCanonical: false,
      contentChars: 0,
      pagesFetched: 0,
    });
    expect(g.defects).toHaveLength(2);
    expect(g.defects.every((d) => d.startsWith("DEFECT:"))).toBe(true);
  });

  /**
   * The legacy shape (M3R3 C3 audit): a cached pre-C3 row stores its own
   * mechanics but never the page text behind them. The mechanics rules can
   * still be run against it at zero cost — and must be, because that row
   * otherwise reaches Session Zero at confidence 75 with an empty gap list.
   * The text floor is the one rule that has nothing to read there.
   */
  it("skipTextFloor: the text rule sits out, the mechanics rules still fire", () => {
    const g = coverageGates({
      mechanicsImplied: true,
      powerSystemPresent: false,
      statsCanonical: false,
      contentChars: 0,
      pagesFetched: 20,
      skipTextFloor: true,
    });
    expect(g.defective).toBe(true);
    expect(g.defects).toHaveLength(1);
    expect(g.defects[0]).toContain("DEFECT: genre/tags imply a game-mechanics power system");
    expect(g.defects.join(" ")).not.toContain("groundable source text");
  });

  it("skipTextFloor cannot manufacture a clean bill — a sound shape stays clean either way", () => {
    const legacyClean = { ...clean, contentChars: 0, pagesFetched: 20, skipTextFloor: true };
    expect(coverageGates(legacyClean).defective).toBe(false);
    // …and the floor is only skipped when asked: the same inputs without the
    // flag still fail on zero groundable text.
    expect(coverageGates({ ...legacyClean, skipTextFloor: false }).defective).toBe(true);
  });

  /**
   * The voice organ (M2R4/M2R5 starvation, gated M3R4 B3). Zero cards shipped
   * silently for two milestones — no reader minded, no gap named it, nothing
   * counted them.
   */
  it("cast material + ZERO voice cards → defective, named out loud", () => {
    const g = coverageGates({ ...clean, castMaterialPresent: true, voiceCardCount: 0 });
    expect(g.defective).toBe(true);
    expect(g.defects).toHaveLength(1);
    expect(g.defects[0]).toContain("ZERO voice cards");
  });

  it("one card is enough to clear it — the gate counts presence, never quality", () => {
    expect(
      coverageGates({ ...clean, castMaterialPresent: true, voiceCardCount: 1 }).defective,
    ).toBe(false);
  });

  it("a genuinely cast-less source shipping no cards is an honest absence, not a defect", () => {
    expect(
      coverageGates({ ...clean, castMaterialPresent: false, voiceCardCount: 0 }).defective,
    ).toBe(false);
  });

  it("a caller that cannot see the cards (the cached legacy row) never trips it", () => {
    // Both inputs absent — the gate sits out exactly as the text floor does.
    expect(coverageGates({ ...clean, castMaterialPresent: true }).defective).toBe(false);
    expect(coverageGates({ ...clean, voiceCardCount: 0 }).defective).toBe(false);
  });
});

describe("deriveTrust defect + grounding plumbing (M3R3 C3)", () => {
  it("defects lead coverage_gaps and set defective — grounding gaps do neither", () => {
    const t = deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      voiceQuoteCharacters: 2,
      defects: ["DEFECT: named hole"],
      groundingGaps: ["grounding: unsupported claim"],
    });
    expect(t.defective).toBe(true);
    expect(t.coverage_gaps[0]).toBe("DEFECT: named hole");
    expect(t.coverage_gaps).toContain("grounding: unsupported claim");
    // The gates answer a DIFFERENT question than coverage — a defect must not
    // silently move the confidence number.
    expect(t.derived_confidence).toBe(75);
  });

  it("grounding gaps alone never mark a profile defective", () => {
    const t = deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      voiceQuoteCharacters: 2,
      groundingGaps: ["grounding: unsupported claim"],
    });
    expect(t.defective).toBe(false);
    expect(t.coverage_gaps).toContain("grounding: unsupported claim");
  });

  it("a run with neither is not defective — the flag defaults off, never on", () => {
    expect(deriveTrust({ ...base }).defective).toBe(false);
  });
});

/**
 * The grounding state (M3R3 C3 audit; widened to an enum by the re-audit). An
 * auditor that threw used to leave a record indistinguishable from an
 * audited-clean one — every label standing, no gap, `notes` the only witness
 * and nothing instructed to read it. The boolean that fixed that then
 * conflated "the auditor failed" with "there was nothing to audit", and the
 * conductor's disclosure rule keyed on the conflation. Four states, one fact
 * each.
 */
describe("deriveTrust grounding state (M3R3 C3)", () => {
  const withGrounding = (grounding?: Parameters<typeof deriveTrust>[0]["grounding"]) =>
    deriveTrust({
      ...base,
      pagesFetched: 15,
      contentChars: 60_000,
      ...(grounding ? { grounding } : {}),
    });

  it("every state rides through as an INPUT — none moves confidence arithmetic", () => {
    const baseline = withGrounding().derived_confidence;
    for (const state of ["audited", "no_claims", "unavailable", "unknown"] as const) {
      const t = withGrounding(state);
      expect(t.grounding).toBe(state);
      expect(t.derived_confidence).toBe(baseline);
    }
  });

  it("defaults unknown — an unstated pass is an unjudged row, never a passed one", () => {
    expect(deriveTrust({ ...base }).grounding).toBe("unknown");
    expect(withGrounding().grounding).toBe("unknown");
  });

  it("no_claims is not a gap: nothing auditable is the ordinary non-mechanics shape", () => {
    const t = withGrounding("no_claims");
    // The state is a fact about the RUN; only real holes reach the player.
    expect(t.coverage_gaps.some((g) => g.includes("unaudited"))).toBe(false);
    expect(t.defective).toBe(false);
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
