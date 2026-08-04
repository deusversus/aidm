import type { Db } from "@/lib/db";
import { BEBOP_DNA } from "@/lib/renderer/__tests__/fixtures";
import type { Profile } from "@/lib/types/profile";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AniListMedia, FranchiseWalk } from "../anilist";
import type { NarrativeSynthesis, TonalInterpretation } from "../synthesize";
import type { IdentityRescue, TopicSearchResult } from "../websearch";
import type { CanonicalPageType, WikiPage } from "../wiki";

/**
 * The fallback chain, wired (M3R3 C2). v3's terminal fallback was ORPHANED by
 * a rewrite — defined, documented, never called — and nobody noticed until
 * this plan's archaeology found the dead call sites. These tests exist so the
 * same silence is impossible here: each level is walked through the REAL
 * researchTitle, and the trust record is checked for the honest label rather
 * than the flattering one.
 */

const {
  searchAnimeMock,
  fetchByIdMock,
  walkFranchiseMock,
  findWikiMock,
  listCategoriesMock,
  planScrapeMock,
  categoryMembersMock,
  fetchPageMock,
  interpretTonalMock,
  synthesizePowerSystemMock,
  synthesizeVoiceCardsMock,
  synthesizeStatMappingMock,
  synthesizeNarrativeMock,
  searchIdentityMock,
  searchTopicsMock,
  writeCorpusMock,
} = vi.hoisted(() => ({
  searchAnimeMock: vi.fn(),
  fetchByIdMock: vi.fn(),
  walkFranchiseMock: vi.fn(),
  findWikiMock: vi.fn(),
  listCategoriesMock: vi.fn(),
  planScrapeMock: vi.fn(),
  categoryMembersMock: vi.fn(),
  fetchPageMock: vi.fn(),
  interpretTonalMock: vi.fn(),
  synthesizePowerSystemMock: vi.fn(),
  synthesizeVoiceCardsMock: vi.fn(),
  synthesizeStatMappingMock: vi.fn(),
  synthesizeNarrativeMock: vi.fn(),
  searchIdentityMock: vi.fn(),
  searchTopicsMock: vi.fn(),
  writeCorpusMock: vi.fn(),
}));

vi.mock("@/lib/research/anilist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/anilist")>();
  // pickBestMatch/mergeSeasons/relevantTags stay REAL — the rescue's retry
  // ladder runs through them, so mocking them would test the mock.
  return {
    ...actual,
    searchAnime: searchAnimeMock,
    fetchById: fetchByIdMock,
    walkFranchise: walkFranchiseMock,
  };
});
vi.mock("@/lib/research/wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/wiki")>();
  // extractQuotes stays real: quote-fed voice labels are part of what's under
  // test, and the search pages must earn them the same way wiki pages do.
  return {
    ...actual,
    findWiki: findWikiMock,
    listCategories: listCategoriesMock,
    planScrape: planScrapeMock,
    categoryMembers: categoryMembersMock,
    fetchPage: fetchPageMock,
  };
});
vi.mock("@/lib/research/synthesize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/synthesize")>();
  return {
    ...actual,
    interpretTonal: interpretTonalMock,
    synthesizePowerSystem: synthesizePowerSystemMock,
    synthesizeVoiceCards: synthesizeVoiceCardsMock,
    synthesizeStatMapping: synthesizeStatMappingMock,
    synthesizeNarrative: synthesizeNarrativeMock,
  };
});
vi.mock("@/lib/research/websearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/websearch")>();
  // missingTopics / SEARCH_TOPICS / mediaFromWebIdentity stay real — the
  // selector and the synthetic identity ARE the wiring under test.
  return { ...actual, searchIdentity: searchIdentityMock, searchTopics: searchTopicsMock };
});
vi.mock("@/lib/research/corpus", () => ({ writeCorpus: writeCorpusMock }));
vi.mock("@/lib/llm/voyage", () => ({ getVoyage: vi.fn(), embedTexts: vi.fn() }));

// --- fixtures ---------------------------------------------------------------

const MEDIA: AniListMedia = {
  id: 1,
  idMal: 1,
  title: { romaji: "Test Show", english: "Test Show", native: null },
  synonyms: [],
  format: "TV",
  status: "FINISHED",
  episodes: 12,
  description: "A show.",
  genres: ["Action"],
  tags: [],
  averageScore: 80,
  popularity: 1000,
  characters: { edges: [] },
  relations: { edges: [] },
  studios: { nodes: [] },
  startDate: { year: 2000 },
  season: null,
  source: null,
  isAdult: false,
};

const WALK: FranchiseWalk = {
  continuityGroups: [{ base: "test show", displayTitle: "Test Show", ids: [MEDIA.id] }],
  fetched: new Map([[MEDIA.id, MEDIA]]),
  siblings: [],
};

const TONAL: TonalInterpretation = {
  treatment: BEBOP_DNA,
  framing: {
    tension_source: "moral",
    power_expression: "balanced",
    narrative_focus: "ensemble",
    mode: "standard",
    antagonist_origin: "societal",
    antagonist_multiplicity: "shifting",
    arc_shape: "rising",
    resolution_trajectory: "ongoing",
    escalation_pattern: "linear",
    status_quo_stability: "gradual",
    player_role: "protagonist",
    choice_weight: "local",
    story_time_density: "months",
  },
  combat_style: "tactical",
  power_distribution: {
    peak_tier: "T3",
    typical_tier: "T7",
    floor_tier: "T10",
    gradient: "spike",
  },
  storytelling_tropes: {
    tournament_arc: false,
    training_montage: false,
    power_of_friendship: false,
    mentor_death: false,
    chosen_one: false,
    tragic_backstory: true,
    redemption_arc: false,
    betrayal: false,
    sacrifice: false,
    transformation: false,
    forbidden_technique: false,
    time_loop: false,
    false_identity: false,
    ensemble_focus: true,
    slow_burn_romance: false,
  },
  visual_style: {
    art_style: "hand-inked, heavy blacks",
    color_palette: "rust and neon",
    reference_descriptors: [],
  },
};

const NARRATIVE: NarrativeSynthesis = {
  director_personality: "Cut on the beat the trumpet drops, never on the punch.",
  author_voice: {
    sentence_patterns: [],
    structural_motifs: [],
    dialogue_quirks: [],
    emotional_rhythm: [],
    example_voice: "The rain kept its own time, and nobody argued with it.",
  },
  cast_depth_posture: {
    main_cast: "broad and deep",
    supporting: "role-filling with one surprise each",
    recurring_bits: "sketch",
  },
};

const QUOTED = 'She only said, "I do not chase what is already gone, and neither should you."';

function searchPage(key: string, pageType: CanonicalPageType, text: string, url: string): WikiPage {
  return { title: `Test Show — ${key} (web research)`, pageType, text, url, origin: "web_search" };
}

function topicResult(pages: WikiPage[], topicUrls: Record<string, string[]>): TopicSearchResult {
  const urls = Object.values(topicUrls).flat();
  return {
    pages,
    topicUrls,
    searchedUrls: urls.map((url) => ({ url, title: url })),
    searchCount: urls.length,
  };
}

function rescueFor(overrides: Partial<IdentityRescue["identity"]> = {}): IdentityRescue {
  return {
    identity: {
      exists: true,
      candidate_titles: ["Real Title"],
      official_title: "Real Title",
      romaji_title: "Riaru Taitoru",
      media_type: "anime",
      start_year: 2021,
      genres: ["Action"],
      tags: ["Ensemble Cast"],
      synopsis: "A show that AniList never indexed.",
      status: "ongoing",
      notes: "",
      ...overrides,
    },
    searchedUrls: [{ url: "https://anidb.net/real-title", title: "AniDB" }],
    searchCount: 2,
  };
}

interface InsertedProfileRow {
  anilistId: number | null;
  malId: number | null;
  profile: Profile;
}

function stubDb(rows: InsertedProfileRow[]): Db {
  return {
    insert: () => ({
      values: (row: InsertedProfileRow) => {
        rows.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  } as unknown as Db;
}

// --- suite ------------------------------------------------------------------

describe("researchTitle fallback chain (M3R3 C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VOYAGE_API_KEY", "test-key");
    searchAnimeMock.mockResolvedValue([MEDIA]);
    fetchByIdMock.mockResolvedValue(MEDIA);
    walkFranchiseMock.mockResolvedValue(WALK);
    findWikiMock.mockResolvedValue(null);
    listCategoriesMock.mockResolvedValue([]);
    planScrapeMock.mockResolvedValue({ categories: [], ip_notes: "" });
    categoryMembersMock.mockResolvedValue([]);
    fetchPageMock.mockResolvedValue(null);
    interpretTonalMock.mockResolvedValue(TONAL);
    synthesizePowerSystemMock.mockResolvedValue({
      name: "Ember Threads",
      mechanics: "Burn memory to move faster than the eye.",
      limitations: "Each thread costs a year of recollection.",
      tiers: [],
    });
    synthesizeVoiceCardsMock.mockResolvedValue([]);
    synthesizeStatMappingMock.mockResolvedValue({
      has_canonical_stats: false,
      confidence: 0,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    });
    synthesizeNarrativeMock.mockResolvedValue(NARRATIVE);
    searchTopicsMock.mockResolvedValue(topicResult([], {}));
    writeCorpusMock.mockResolvedValue({ chunks: 7 });
  });

  it("LEVEL C full sweep: a wiki that yields no pages is rescued by search — api_search, labeled web_search", async () => {
    // A MAIN cast on the AniList row: the gap-fill path voice falls back to
    // when the only "characters" page is a search stub.
    const cast: AniListMedia = {
      ...MEDIA,
      characters: { edges: [{ role: "MAIN", node: { name: { full: "Spike", native: null } } }] },
    };
    searchAnimeMock.mockResolvedValue([cast]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[cast.id, cast]]),
    } satisfies FranchiseWalk);
    findWikiMock.mockResolvedValue({ base: "https://test.fandom.com", articles: 40 });
    listCategoriesMock.mockResolvedValue(["Characters"]);
    planScrapeMock.mockResolvedValue({
      categories: [{ wiki_category: "Characters", canonical_type: "characters", priority: 1 }],
      ip_notes: "",
    });
    // The founding defect's own shape: the wiki exists and gives nothing.
    categoryMembersMock.mockResolvedValue([]);
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed; the cost is a year per thread.",
            "https://src/power",
          ),
          searchPage("characters", "characters", QUOTED, "https://src/chars"),
          searchPage(
            "world",
            "locations",
            "The Ashfall Reach is walled; the Ledger Houses run its trade.",
            "https://src/world",
          ),
          searchPage(
            "stats",
            "lore",
            "The Ledger shows RANK and THREADCOUNT for every bearer.",
            "https://src/stats",
          ),
        ],
        {
          power_system: ["https://src/power"],
          characters: ["https://src/chars"],
          world: ["https://src/world"],
          stats: ["https://src/stats"],
        },
      ),
    );
    synthesizeStatMappingMock.mockResolvedValue({
      has_canonical_stats: true,
      confidence: 95,
      system_name: "The Ledger",
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    });

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    expect(report.trust.method).toBe("api_search");
    expect(report.pagesFetched).toBe(4);
    const sources = report.trust.field_sources;
    expect(sources.power_system).toBe("web_search");
    expect(sources.stat_mapping).toBe("web_search");
    // Nothing scraped, so nothing may claim the wiki label.
    expect(Object.values(sources)).not.toContain("wiki_page");
    // field_pages read the topic's backing urls, not the page stub's.
    expect(report.trust.field_pages.power_system).toEqual(["https://src/power"]);
    expect(report.trust.sources_consulted).toContain("https://src/stats");
    expect(report.trust.sources_consulted).toContain("https://test.fandom.com");
    // The harvest reaches the corpus like any scraped page.
    const corpusPages = writeCorpusMock.mock.calls[0]?.[2] as WikiPage[];
    expect(corpusPages).toHaveLength(4);
    expect(corpusPages.every((p) => p.origin === "web_search")).toBe(true);
    expect(rows[0]?.profile.research_trust?.method).toBe("api_search");

    // A SEARCH PAGE'S TITLE IS NOT A CANON NOUN. The world topic grounds the
    // corpus, but its fabricated label ("Test Show — world (web research)")
    // must never reach world_setting.locations — §5's compiler signs that
    // straight into the premise contract's World component.
    const world = rows[0]?.profile.ip_mechanics.world_setting;
    expect(world?.locations).toEqual([]);
    expect(world?.factions).toEqual([]);
    expect(JSON.stringify(world)).not.toContain("web research");
    // Honest consequence, carried: no wiki page fed the FIELD, so it keeps
    // the AniList genre and claims no page provenance.
    expect(sources.world_setting).toBe("anilist");
    expect(report.trust.field_pages.world_setting).toBeUndefined();

    // Nor is it a speaker: the one-page-one-character assumption holds only
    // for wiki pages, so the search characters page feeds no quote key and
    // no voice card is minted under its pseudo-name.
    expect(synthesizeVoiceCardsMock).toHaveBeenCalledTimes(1);
    const [quotes, gapFill] = synthesizeVoiceCardsMock.mock.calls[0] as [
      Record<string, string[]>,
      string[],
    ];
    expect(Object.keys(quotes)).toEqual([]);
    expect(gapFill).toEqual(["Spike"]); // the AniList cast carries voice instead
    expect(sources.voice_cards).toBe("model_recall");
    expect(report.trust.coverage_gaps.join(" | ")).toContain("no character quotes");
  }, 20_000);

  it("LEVEL A: AniList misses the player's name for it, search rescues the identity, the run proceeds", async () => {
    searchAnimeMock.mockImplementation(async (t: string) => (t === "Real Title" ? [MEDIA] : []));
    searchIdentityMock.mockResolvedValue(rescueFor());
    findWikiMock.mockResolvedValue({ base: "https://test.fandom.com", articles: 40 });
    listCategoriesMock.mockResolvedValue(["Characters"]);
    planScrapeMock.mockResolvedValue({
      categories: [{ wiki_category: "Characters", canonical_type: "characters", priority: 1 }],
      ip_notes: "",
    });
    categoryMembersMock.mockResolvedValue(["Spike"]);
    fetchPageMock.mockImplementation(
      async (base: string, title: string, pageType: CanonicalPageType) => ({
        title,
        pageType,
        text: QUOTED,
        url: `${base}/wiki/${title}`,
      }),
    );

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "that knight isekai one");

    expect(searchIdentityMock).toHaveBeenCalledWith("that knight isekai one");
    expect(report.notes.join(" | ")).toContain("identity resolved via web search");
    expect(report.title).toBe("Test Show");
    // One thin page: the supplement fires, but only for the STARVED organs —
    // characters scraped, so characters is not re-bought (v3 L1266-1294).
    const requestedTopics = (
      searchTopicsMock.mock.calls[0]?.[1] as { key: string }[] | undefined
    )?.map((t) => t.key);
    expect(requestedTopics).toBeDefined();
    expect(requestedTopics).not.toContain("characters");
    // The supplement came back dry — the scraped page still carries the run.
    expect(report.trust.method).toBe("api_wiki");
    expect(report.trust.field_sources.voice_cards).toBe("wiki_page");
    expect(rows[0]?.anilistId).toBe(1);
  }, 20_000);

  it("LEVEL B: no AniList row at all — a cited identity carries the profile, and the row keeps no fake id", async () => {
    searchAnimeMock.mockResolvedValue([]);
    searchIdentityMock.mockResolvedValue(rescueFor({ official_title: "Phantom Work" }));
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "stats",
            "lore",
            "The Ledger shows RANK and THREADCOUNT for every bearer.",
            "https://src/stats",
          ),
        ],
        { stats: ["https://src/stats"] },
      ),
    );

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "that phantom novel");

    expect(report.title).toBe("Phantom Work");
    expect(report.trust.method).toBe("web_search");
    expect(report.notes.join(" | ")).toContain("grounded in live web search");
    // No AniList row was consulted — the record must not claim one.
    expect(report.trust.sources_consulted).not.toContain("anilist");
    expect(report.trust.sources_consulted).toContain("https://anidb.net/real-title");
    expect(rows[0]?.anilistId).toBeNull();
    expect(rows[0]?.malId).toBeNull();
    expect(rows[0]?.profile.anilist_id).toBeUndefined();
    expect(rows[0]?.profile.research_trust?.method).toBe("web_search");
    // The player's own words are kept as an alias: the LLM-derived official
    // title is not stable enough to be the only cache key, and the probe on
    // the next call keys on what they typed.
    expect(rows[0]?.profile.alternate_titles).toContain("that phantom novel");
    // The world topic came back dry, so world_setting is bare genre — which
    // came from the WEB identity. Claiming "anilist" would contradict this
    // same record's sources_consulted.
    expect(report.trust.field_sources.world_setting).toBe("web_search");
    // 20 floor + 10 (identity verified by CITATION, not AniList's 15) + 15
    // (one thin page) = 45.
    expect(report.trust.derived_confidence).toBe(45);
  }, 20_000);

  it("the alias cache probe: the player's own words answer from cache BEFORE the paid identity search", async () => {
    // AniList still misses (the title has no row) — the shape that used to
    // re-buy searchIdentity on every single conductor turn.
    searchAnimeMock.mockResolvedValue([]);
    const stored = {
      id: "phantom_work",
      title: "Phantom Work",
      scopeClass: "standard",
      profile: {
        alternate_titles: ["Riaru Taitoru", "That Phantom Novel!"],
        research_trust: {
          method: "web_search",
          derived_confidence: 45,
          sources_consulted: ["https://anidb.net/real-title"],
          pages_fetched: 1,
          post_cutoff: false,
          field_sources: {},
          field_pages: {},
          coverage_gaps: [],
        },
      },
      researchProvenance: { confidence: 45, wikiBase: null, seasonsMerged: 0, pagesFetched: 1 },
    };
    const cachedDb = {
      // The probe is a full-table scan (tens of rows) — no .where().
      select: () => ({ from: async () => [stored] }),
      insert: () => {
        throw new Error("the cached path must not rewrite the profile");
      },
    } as unknown as Db;

    const { researchTitle } = await import("../research");
    // Different casing and punctuation from every stored string — the match
    // is deliberately loose, because title drift is the whole failure mode.
    const report = await researchTitle(cachedDb, "that phantom novel", { reuseExisting: true });

    expect(report.profileId).toBe("phantom_work");
    expect(report.title).toBe("Phantom Work");
    expect(report.confidence).toBe(45);
    expect(report.trust.method).toBe("web_search");
    expect(report.notes.join(" | ")).toContain("profile cached");
    // Nothing paid: §8 says the conductor never re-buys research.
    expect(searchIdentityMock).not.toHaveBeenCalled();
    expect(searchTopicsMock).not.toHaveBeenCalled();
    expect(interpretTonalMock).not.toHaveBeenCalled();
    expect(synthesizeNarrativeMock).not.toHaveBeenCalled();
    expect(writeCorpusMock).not.toHaveBeenCalled();
  }, 20_000);

  it("TERMINAL RECALL: no wiki AND search unavailable — the run completes and says so out loud", async () => {
    searchTopicsMock.mockRejectedValue(new Error("web_search: unavailable"));

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    expect(report.trust.method).toBe("anilist_only");
    expect(report.notes.join(" | ")).toContain("web search unavailable");
    expect(report.trust.coverage_gaps.join(" | ")).toContain("zero source pages");
    expect(report.trust.field_sources.world_setting).toBe("anilist");
    expect(rows[0]?.profile.research_trust?.method).toBe("anilist_only");
  }, 20_000);

  it("the §8 guard holds: AniList dry AND search finds no real work → refusal names both", async () => {
    searchAnimeMock.mockResolvedValue([]);
    searchIdentityMock.mockResolvedValue(
      rescueFor({ exists: false, candidate_titles: [], official_title: "" }),
    );

    const { researchTitle } = await import("../research");
    await expect(researchTitle(stubDb([]), "asdfqwer")).rejects.toThrow(
      /live web search found no real work behind it/,
    );
  }, 20_000);
});
