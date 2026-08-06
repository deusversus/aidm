import type { Db } from "@/lib/db";
import { BEBOP_DNA } from "@/lib/renderer/__tests__/fixtures";
import type { Profile } from "@/lib/types/profile";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AniListMedia, FranchiseWalk } from "../anilist";
import type { GroundingClaim, NarrativeSynthesis, TonalInterpretation } from "../synthesize";
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
  groundProfileMock,
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
  groundProfileMock: vi.fn(),
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
  // sourceExcerptBlock stays REAL: what interpretTonal and the grounding pass
  // actually SEE is part of the wiring under test (grounding.test.ts pins the
  // selector itself).
  return {
    ...actual,
    interpretTonal: interpretTonalMock,
    synthesizePowerSystem: synthesizePowerSystemMock,
    synthesizeVoiceCards: synthesizeVoiceCardsMock,
    synthesizeStatMapping: synthesizeStatMappingMock,
    synthesizeNarrative: synthesizeNarrativeMock,
    groundProfile: groundProfileMock,
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

type Claim = GroundingClaim;

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
    // A HEALTHY default (M3R4 B3): zero cards is now a coverage DEFECT whenever
    // the run had cast material, so the suite's baseline must be a run whose
    // voice organ is not empty. The starvation case has its own test below.
    synthesizeVoiceCardsMock.mockResolvedValue([
      {
        name: "Spike",
        signature_phrases: [],
        speech_patterns: "clipped",
        humor_type: "Sardonic",
        dialogue_rhythm: "drawled",
        emotional_expression: "Deflecting",
      },
    ]);
    synthesizeStatMappingMock.mockResolvedValue({
      has_canonical_stats: false,
      confidence: 0,
      aliases: {},
      meta_resources: {},
      hidden: [],
      display_order: [],
    });
    synthesizeNarrativeMock.mockResolvedValue(NARRATIVE);
    // The grounding auditor upholds everything unless a test says otherwise —
    // the demotion cases below are the interesting ones.
    groundProfileMock.mockImplementation(async (_t: string, claims: Claim[]) => ({
      verdicts: claims.map((c) => ({ key: c.key, supported: true })),
    }));
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
    // no voice card is minted under its pseudo-name. It is NOT discarded,
    // though (M2R4/M2R5 starvation, repaired M3R4 B3): it rides in as the
    // unattributed cast corpus, which is what M3R3 harvested it for.
    expect(synthesizeVoiceCardsMock).toHaveBeenCalledTimes(1);
    const [quotes, gapFill, corpus] = synthesizeVoiceCardsMock.mock.calls[0] as [
      Record<string, string[]>,
      string[],
      WikiPage[],
    ];
    expect(Object.keys(quotes)).toEqual([]);
    expect(gapFill).toEqual(["Spike"]); // the AniList cast still carries the names
    expect(corpus.map((p) => p.url)).toEqual(["https://src/chars"]);
    expect(corpus[0]?.text).toBe(QUOTED);
    // The label follows the material: searched prose fed the organ, so the
    // record says web_search rather than borrowing wiki's credit — and rather
    // than the model_recall it claimed while the corpus went unread.
    expect(sources.voice_cards).toBe("web_search");
    expect(report.trust.field_pages.voice_cards).toEqual(["https://src/chars"]);
    // The quote gap is unchanged and still honest: no ATTRIBUTED quotes exist.
    expect(report.trust.coverage_gaps.join(" | ")).toContain("no character quotes");

    // M3R3 C3 / L3: the tonal read gets the HARVEST, not the synopsis alone.
    // Until C3 this call saw `mediaBlock(media)` and nothing else, so canonical
    // DNA, framing, tropes and visual style were recall BY CONSTRUCTION even on
    // a run that fetched four grounded pages.
    const [, tonalPages] = interpretTonalMock.mock.calls[0] as [AniListMedia, WikiPage[]];
    expect(tonalPages).toHaveLength(4);
    expect([...tonalPages].map((p) => p.pageType).sort()).toEqual([
      "characters",
      "locations",
      "lore",
      "techniques",
    ]);
    const { sourceExcerptBlock } = await import("../synthesize");
    expect(sourceExcerptBlock(tonalPages)).toContain("Ashfall Reach");
    // …and the label follows the pages: search-fed, so it says web_search.
    expect(sources.canonical_dna).toBe("web_search");
    expect(sources.visual_style).toBe("web_search");
    // Group B still reads the assembled profile, not the sources.
    expect(sources.author_voice).toBe("model_recall");
    // The auditor was shown the desk's own FACTUAL claims, keyed for wiring —
    // and each one carries the pages that fed it, never a run-wide window.
    const asked = groundProfileMock.mock.calls[0]?.[1] as Claim[];
    expect(asked.map((c) => c.key).sort()).toEqual(["power_system", "stat_mapping"]);
    const evidenceFor = (key: string) => asked.find((c) => c.key === key)?.evidence ?? "";
    expect(evidenceFor("power_system")).toContain("Ember Threads burn memory");
    expect(evidenceFor("stat_mapping")).toContain("RANK and THREADCOUNT");
    // Each claim's evidence is its OWN organ's pages: the stat mapping's lore
    // page is not what the power system is judged against, and vice versa.
    expect(evidenceFor("power_system")).not.toContain("THREADCOUNT");
    expect(evidenceFor("stat_mapping")).not.toContain("Ember Threads");
    // NO TONAL CLAIM EXISTS. A 0-10 interpretive score is not a source-
    // checkable fact, so the auditor is never asked to grade one — and the
    // tonal labels below stand on what interpretTonal structurally READ.
    expect(asked.some((c) => c.key.includes("tonal"))).toBe(false);
    // The pass ran and reconciled, so the record says the profile was audited.
    expect(report.trust.grounding).toBe("audited");
  }, 20_000);

  it("VOICE STARVATION (M2R4/M2R5 carry): a run with cast material and ZERO cards is a DEFECT", async () => {
    // Same shape as the sweep above — an AniList main cast AND a searched
    // characters harvest — but the synthesis comes back empty. For two
    // milestones that passed in silence: every reader tolerates `[]`, the
    // "no character quotes" gap reads identically for eight recall cards and
    // for none, and nothing counted them.
    const cast: AniListMedia = {
      ...MEDIA,
      characters: { edges: [{ role: "MAIN", node: { name: { full: "Spike", native: null } } }] },
    };
    searchAnimeMock.mockResolvedValue([cast]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[cast.id, cast]]),
    } satisfies FranchiseWalk);
    searchTopicsMock.mockResolvedValue(
      topicResult([searchPage("characters", "characters", QUOTED, "https://src/chars")], {
        characters: ["https://src/chars"],
      }),
    );
    synthesizeVoiceCardsMock.mockResolvedValue([]);

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    expect(report.trust.defective).toBe(true);
    expect(report.trust.coverage_gaps.join(" | ")).toContain("ZERO voice cards");
    // …and the empty organ never claims a source it did not earn.
    expect(report.trust.field_sources.voice_cards).toBe("model_recall");
    expect(report.trust.field_pages.voice_cards).toBeUndefined();
  }, 20_000);

  it("GROUNDING DEMOTION: the sources don't carry the power system → its label falls to recall", async () => {
    // A full sweep with one grounded techniques page: enough source text to
    // clear the L4 floor, so the ONLY thing under test is the verdict.
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "The Ashfall Reach is walled and the Ledger Houses run its trade. Bearers are ranked by the Ledger, which the sources describe at length across several pages of history, geography, and the trade compacts between the Houses that keep the Reach fed through winter.",
            "https://src/power",
          ),
        ],
        { power_system: ["https://src/power"] },
      ),
    );
    groundProfileMock.mockImplementation(async (_t: string, claims: Claim[]) => ({
      verdicts: claims.map((c) => ({ key: c.key, supported: c.key !== "power_system" })),
    }));

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // The system is STILL in the profile — C4 owns player-facing surgery.
    // What died is the claim that a source backed it.
    expect(rows[0]?.profile.ip_mechanics.power_system?.name).toBe("Ember Threads");
    expect(report.trust.field_sources.power_system).toBe("model_recall");
    expect(report.trust.field_pages.power_system).toBeUndefined();
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding: the power system as synthesized is not supported by the fetched sources",
    );
    // 20 floor + 15 (AniList identity) + 15 (one thin page: pagesFetched > 0
    // but under the 10-page/15k-char rich bar) + 5 (power system present but
    // NOT from pages — the demotion is worth exactly the 10-vs-5 difference).
    // No stats credit (the mapping is the default) and no quote credit. An
    // upheld verdict would read 60.
    expect(report.trust.derived_confidence).toBe(55);
    // A rejected claim is a gap, never a defect: the profile is not broken.
    expect(report.trust.defective).toBe(false);
    // THE TONAL LABELS ARE UNTOUCHED BY ANY VERDICT. No tonal claim is ever
    // put to the auditor — the label states what interpretTonal READ, and a
    // rejected power system says nothing about that.
    const asked = groundProfileMock.mock.calls[0]?.[1] as Claim[];
    expect(asked.map((c) => c.key)).toEqual(["power_system"]);
    expect(report.trust.field_sources.canonical_dna).toBe("web_search");
    expect(report.trust.grounding).toBe("audited");
  }, 20_000);

  it("FAIL CLOSED: a claim the auditor never answers is UNSUPPORTED, and says so", async () => {
    // Two claims asked (power system + stat mapping), one verdict returned —
    // the shape the schema explicitly allows and the old wiring read as
    // consent. A dropped or re-keyed answer must land where doubt lands.
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed, and the sources describe the cost at length across the compacts, the histories, and the trade of the Reach.",
            "https://src/power",
          ),
          searchPage(
            "stats",
            "lore",
            "The Ledger shows RANK and THREADCOUNT for every bearer, recorded in the Houses' own books.",
            "https://src/stats",
          ),
        ],
        { power_system: ["https://src/power"], stats: ["https://src/stats"] },
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
    groundProfileMock.mockResolvedValue({
      verdicts: [{ key: "stat_mapping", supported: true }],
    });

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    expect((groundProfileMock.mock.calls[0]?.[1] as Claim[]).map((c) => c.key).sort()).toEqual([
      "power_system",
      "stat_mapping",
    ]);
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding: no verdict returned for power_system — treated as unsupported",
    );
    // …and the silence carries the full consequence, not just a note.
    expect(report.trust.field_sources.power_system).toBe("model_recall");
    expect(report.trust.field_pages.power_system).toBeUndefined();
    // The answered claim keeps everything it earned.
    expect(report.trust.field_sources.stat_mapping).toBe("web_search");
    expect(report.trust.grounding).toBe("audited");
  }, 20_000);

  it("ANY FALSE WINS: a duplicated key cannot talk the auditor out of an unsupported verdict", async () => {
    // GroundingVerdicts is an unconstrained array — the grammar cannot forbid
    // two entries for one claim, and "exactly one verdict per claim" is prose.
    // Map-last-wins made a contradicting second entry fail-OPEN.
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed, and the sources describe the cost at length across the compacts, the histories, and the trade of the Reach.",
            "https://src/power",
          ),
        ],
        { power_system: ["https://src/power"] },
      ),
    );
    groundProfileMock.mockResolvedValue({
      verdicts: [
        { key: "power_system", supported: false },
        { key: "power_system", supported: true },
      ],
    });

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // The FALSE verdict stands: the label falls to recall and the gap is named.
    expect(report.trust.field_sources.power_system).toBe("model_recall");
    expect(report.trust.field_pages.power_system).toBeUndefined();
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding: the power system as synthesized is not supported by the fetched sources",
    );
    // The pass itself still RAN and reconciled every claim it was asked.
    expect(report.trust.grounding).toBe("audited");
  }, 20_000);

  it("EVIDENCE PARITY: the auditor is shown every page synthesizePowerSystem read, uncut", async () => {
    // Five technique pages, each fatter than the per-page clip. Under the old
    // 3-pages × 800-chars evidence window, pages 4 and 5 were invisible to the
    // auditor while the synthesis had read them — a false demotion BY
    // CONSTRUCTION for any system built on them.
    const filler = "the Reach and its compacts, recorded at length. ".repeat(30);
    const techniquePages = Array.from({ length: 6 }, (_, i) =>
      searchPage(
        `power_system_${i}`,
        "techniques",
        `PAGE-${i}-HEAD Ember Threads burn memory. ${filler} PAGE-${i}-TAIL`,
        `https://src/power/${i}`,
      ),
    );
    searchTopicsMock.mockResolvedValue(
      topicResult(techniquePages, { power_system: ["https://src/power"] }),
    );

    const { researchTitle } = await import("../research");
    await researchTitle(stubDb([]), "Test Show");

    const { SYNTHESIS_FEEDS } = await import("../synthesize");
    const asked = groundProfileMock.mock.calls[0]?.[1] as Claim[];
    const evidence = asked.find((c) => c.key === "power_system")?.evidence ?? "";
    // Every page inside the feed window reached the auditor — 4 and 5 included.
    for (let i = 0; i < SYNTHESIS_FEEDS.power_system.pages; i++) {
      expect(evidence).toContain(`PAGE-${i}-HEAD`);
    }
    // …and nothing beyond it did: the window is the synthesis call's, exactly.
    expect(evidence).not.toContain(`PAGE-${SYNTHESIS_FEEDS.power_system.pages}-HEAD`);
    // The per-page clip is the synthesis call's too — the tail sits past it.
    expect(filler.length).toBeGreaterThan(SYNTHESIS_FEEDS.power_system.chars);
    expect(evidence).not.toContain("PAGE-0-TAIL");
  }, 20_000);

  it("STAT MAPPING DEMOTION: the DEFAULT is what persists — profile, record and gate agree", async () => {
    // A mechanics IP whose stat mapping the sources don't back. Before this
    // fix the trust record demoted the label while the profile still shipped
    // has_canonical_stats=true at confidence 95 into the premise contract,
    // where layout keys the diegetic status window on it.
    const litrpg: AniListMedia = {
      ...MEDIA,
      genres: ["Fantasy"],
      tags: [{ name: "LitRPG", rank: 85, isMediaSpoiler: false }],
    };
    searchAnimeMock.mockResolvedValue([litrpg]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[litrpg.id, litrpg]]),
    } satisfies FranchiseWalk);
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed, and the sources describe the cost at length across the compacts, the histories, and the trade of the Reach.",
            "https://src/power",
          ),
          searchPage(
            "stats",
            "lore",
            "The Ledger shows RANK and THREADCOUNT for every bearer, recorded in the Houses' own books.",
            "https://src/stats",
          ),
        ],
        { power_system: ["https://src/power"], stats: ["https://src/stats"] },
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
    groundProfileMock.mockImplementation(async (_t: string, claims: Claim[]) => ({
      verdicts: claims.map((c) => ({ key: c.key, supported: c.key !== "stat_mapping" })),
    }));

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // The PERSISTED profile carries the default — the one v3's ≥90 bar
    // discards — not the kept mapping.
    const stats = rows[0]?.profile.ip_mechanics.stat_mapping;
    expect(stats?.has_canonical_stats).toBe(false);
    expect(stats?.confidence).toBe(0);
    expect(stats?.system_name).toBeUndefined();
    // Absence IS the honest label for content no organ fed.
    expect(report.trust.field_sources.stat_mapping).toBeUndefined();
    expect(report.trust.field_pages.stat_mapping).toBeUndefined();
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding: the canonical stat mapping is not supported by the fetched sources",
    );
    // ORDERING PIN: the coverage gate reads the POST-demotion value, so a
    // mechanics IP whose stat system just died is defective on the same truth
    // the profile ships — not clean because the pre-demotion object said true.
    expect(report.trust.defective).toBe(true);
    expect(report.trust.coverage_gaps[0]).toContain("without a canonical stat mapping");
  }, 20_000);

  it("MECHANICAL VOICE GROUNDING: an invented signature phrase is caught without a model verdict", async () => {
    // The phrase check is a substring test against the pages that fed the
    // voice call — deterministic and free. extractQuotes pulls its phrases
    // verbatim, so a real one passes by construction whatever its casing or
    // quote marks; what fails is voice matter the model made up.
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
    // A technique page from the thin-scrape supplement, so the auditor IS
    // called — and can be shown to have been asked nothing about voice.
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed, and the sources describe the cost at length across the compacts, the histories, and the trade of the Reach.",
            "https://src/power",
          ),
        ],
        { power_system: ["https://src/power"] },
      ),
    );
    synthesizeVoiceCardsMock.mockResolvedValue([
      {
        name: "Spike",
        // Curly quotes and a different case: normalization is what makes the
        // verbatim-extracted phrase survive the trip.
        signature_phrases: ["“I DO NOT CHASE what is already gone”"],
        speech_patterns: "clipped",
        humor_type: "Sardonic",
        dialogue_rhythm: "drawled",
        emotional_expression: "Deflecting",
      },
      {
        name: "Vicious",
        signature_phrases: ["Bang. See you, space cowboy."],
        speech_patterns: "flat",
        humor_type: "none",
        dialogue_rhythm: "terse",
        emotional_expression: "Restrained",
      },
      {
        name: "Faye",
        // TYPOGRAPHY, not invention: the card's phrase is the page's line with
        // an ellipsis and an em dash where the page had a comma and a space.
        // synthesizeVoiceCards RE-EMITS phrases rather than copying them, so
        // this rewrite is routine — and it used to be reported to the player
        // as model-invented voice matter.
        signature_phrases: ["I do not chase … what is already gone—and neither should you"],
        speech_patterns: "wry",
        humor_type: "Deadpan",
        dialogue_rhythm: "loose",
        emotional_expression: "Deflecting",
      },
    ]);

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // ONE ungrounded phrase, not two: the typographic variant folds into the
    // page text, and only the invented line is named.
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding: 1 signature phrase(s) across 1 voice card(s) do not appear in the source pages",
    );
    // The cards themselves are untouched — C4 owns player-facing surgery.
    expect(rows[0]?.profile.ip_mechanics.voice_cards).toHaveLength(3);
    expect(rows[0]?.profile.ip_mechanics.voice_cards[1]?.signature_phrases).toEqual([
      "Bang. See you, space cowboy.",
    ]);
    // NO MODEL VERDICT IS INVOLVED: the auditor was asked about the factual
    // claims only. The phrase came out of the page or it did not.
    const asked = (groundProfileMock.mock.calls[0]?.[1] as Claim[]).map((c) => c.key);
    expect(asked).toEqual(["power_system"]);
    expect(asked.some((k) => k.startsWith("voice"))).toBe(false);
  }, 20_000);

  it("THE AUDITOR FAILS: grounding is 'unavailable' and the record says the profile is unaudited", async () => {
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "power_system",
            "techniques",
            "Ember Threads burn memory for speed, and the sources describe the cost at length across the compacts, the histories, and the trade of the Reach — enough text to clear the groundable-text floor, so the only thing under test here is the auditor's own failure.",
            "https://src/power",
          ),
        ],
        { power_system: ["https://src/power"] },
      ),
    );
    groundProfileMock.mockRejectedValue(new Error("grounding: 529 overloaded"));

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // The run survives its own auditor — but never silently.
    expect(report.trust.grounding).toBe("unavailable");
    expect(report.trust.coverage_gaps.join(" | ")).toContain(
      "grounding pass unavailable — provenance labels ride synthesis structure, unaudited",
    );
    // The state rides ON the persisted record, not only in the return: a later
    // reader of this row must be able to tell it was never checked.
    expect(rows[0]?.profile.research_trust?.grounding).toBe("unavailable");
    expect(rows[0]?.profile.research_trust?.coverage_gaps.join(" | ")).toContain("unaudited");
    // Labels stand where synthesis put them — an unrun audit demotes nothing.
    expect(report.trust.field_sources.power_system).toBe("web_search");
    expect(report.trust.defective).toBe(false);
  }, 20_000);

  it("NOTHING TO AUDIT: a rich non-mechanics scrape is 'no_claims' — not a hole, and no gap", async () => {
    // The re-audit's finding [1]/[5]: a Bebop-shaped run (deep wiki, no
    // technique pages, no canonical stats) offers the auditor no source-
    // checkable claim at all. Under the old boolean that landed as
    // grounded:false — indistinguishable from an auditor failure — and the
    // conductor's disclosure rule then forced a wrongness caveat at the
    // audition with nothing to name.
    findWikiMock.mockResolvedValue({ base: "https://test.fandom.com", articles: 40 });
    listCategoriesMock.mockResolvedValue(["Characters"]);
    planScrapeMock.mockResolvedValue({
      categories: [{ wiki_category: "Characters", canonical_type: "characters", priority: 1 }],
      ip_notes: "",
    });
    categoryMembersMock.mockResolvedValue(Array.from({ length: 12 }, (_, i) => `Character ${i}`));
    fetchPageMock.mockImplementation(
      async (base: string, title: string, pageType: CanonicalPageType) => ({
        title,
        pageType,
        // Rich enough to clear the 10-page / 15k-char bar: this run is healthy
        // by every measure the record carries.
        text: `${QUOTED} ${"The rain kept its own time on the Reach. ".repeat(40)}`,
        url: `${base}/wiki/${title}`,
      }),
    );

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    // No claim existed, so no call was bought — and the state says exactly why.
    expect(groundProfileMock).not.toHaveBeenCalled();
    expect(report.trust.grounding).toBe("no_claims");
    expect(rows[0]?.profile.research_trust?.grounding).toBe("no_claims");
    // NOT a hole: the player-facing channel stays empty and the profile is
    // sound. This is the shape the false "unaudited" caveat fired on.
    expect(report.trust.coverage_gaps).toHaveLength(0);
    expect(report.trust.defective).toBe(false);
    expect(report.trust.derived_confidence).toBe(75);
  }, 20_000);

  it("THE GATE FIRES (L4): a mechanics IP with no power system is DEFECTIVE — and still persists", async () => {
    const litrpg: AniListMedia = {
      ...MEDIA,
      genres: ["Fantasy"],
      tags: [{ name: "LitRPG", rank: 85, isMediaSpoiler: false }],
    };
    searchAnimeMock.mockResolvedValue([litrpg]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[litrpg.id, litrpg]]),
    } satisfies FranchiseWalk);
    // Story pages only: nothing feeds a power system, and the text clears the
    // groundable-text floor so this case isolates the mechanics gate.
    searchTopicsMock.mockResolvedValue(
      topicResult(
        [
          searchPage(
            "story",
            "arcs",
            "The arcs run from the Reach's fall through the Ledger war and into the long winter, each summarized by the sources in enough detail to establish the order of events and the cast that carries them across the seasons.",
            "https://src/story",
          ),
        ],
        { story: ["https://src/story"] },
      ),
    );

    const rows: InsertedProfileRow[] = [];
    const { researchTitle } = await import("../research");
    const report = await researchTitle(stubDb(rows), "Test Show");

    expect(report.trust.defective).toBe(true);
    // DEFECT leads the array — it is the first thing the conductor reads.
    expect(report.trust.coverage_gaps[0]).toContain(
      "DEFECT: genre/tags imply a game-mechanics power system",
    );
    expect(report.notes.join(" | ")).toContain("DEFECT");
    // v3 THREW here. v5 ships the profile and makes SZ say so — the run
    // completes, the row persists, and the flag rides ON the profile.
    expect(rows[0]?.profile.id).toBe("test_show");
    expect(rows[0]?.profile.research_trust?.defective).toBe(true);
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

  it("PRIVATE WORLDS never leave their table: a player_vision row is invisible to the alias probe", async () => {
    searchAnimeMock.mockResolvedValue([]);
    searchIdentityMock.mockResolvedValue(rescueFor({ official_title: "Real Title" }));
    searchTopicsMock.mockResolvedValue(topicResult([], {}));

    /** A select stub the ALIAS probe (no .where) and the SLUG door (.where)
     *  both read — the probe's miss falls through to the second door. */
    const selectStub = (stored: unknown[]) => () => ({
      from: () => Object.assign(Promise.resolve(stored), { where: async () => [] }),
    });

    // One table's invented world, stored in the SHARED profiles table under
    // the world's own NAME — which is exactly what this door matches on.
    const privateWorld = {
      id: "original_11111111-2222-3333-4444-555555555555",
      title: "The Kettle Reach",
      scopeClass: "micro",
      profile: {
        alternate_titles: [],
        research_trust: {
          method: "player_vision",
          derived_confidence: 95,
          sources_consulted: ["player"],
          pages_fetched: 0,
          post_cutoff: false,
          field_sources: {},
          field_pages: {},
          coverage_gaps: [],
        },
      },
      researchProvenance: { confidence: 95, wikiBase: null, seasonsMerged: 0, pagesFetched: 0 },
    };

    const rows: InsertedProfileRow[] = [];
    const privateDb = {
      select: selectStub([privateWorld]),
      insert: () => ({
        values: (row: InsertedProfileRow) => {
          rows.push(row);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as unknown as Db;

    const { researchTitle } = await import("../research");
    const report = await researchTitle(privateDb, "the kettle reach", { reuseExisting: true });

    // §8's cache law covers RESEARCHED sources. Serving one campaign's private
    // world to another as cached "research" at confidence 95 is not caching.
    expect(report.profileId).not.toBe(privateWorld.id);
    expect(report.trust.method).not.toBe("player_vision");
    expect(report.title).toBe("Real Title");
    expect(searchIdentityMock).toHaveBeenCalled();

    // …and a RESEARCHED row under the same title still answers, unpaid: the
    // filter is on the record's method, not on the door itself.
    searchIdentityMock.mockClear();
    searchTopicsMock.mockClear();
    const researched = {
      ...privateWorld,
      id: "kettle_reach",
      scopeClass: "standard",
      profile: {
        alternate_titles: [],
        research_trust: {
          ...privateWorld.profile.research_trust,
          method: "web_search",
          derived_confidence: 45,
          sources_consulted: ["https://anidb.net/kettle"],
          pages_fetched: 1,
        },
      },
      researchProvenance: { confidence: 45, wikiBase: null, seasonsMerged: 0, pagesFetched: 1 },
    };
    const cachedDb = {
      select: selectStub([privateWorld, researched]),
      insert: () => {
        throw new Error("the cached path must not rewrite the profile");
      },
    } as unknown as Db;
    const hit = await researchTitle(cachedDb, "the kettle reach", { reuseExisting: true });
    expect(hit.profileId).toBe("kettle_reach");
    expect(hit.trust.method).toBe("web_search");
    expect(searchIdentityMock).not.toHaveBeenCalled();
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
