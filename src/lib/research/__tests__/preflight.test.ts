import type { Db } from "@/lib/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AniListMedia, FranchiseWalk } from "../anilist";

/**
 * The Voyage preflight regression (research.ts, 2026-07-10): `getVoyage()` runs
 * AFTER the reuseExisting cached-profile early-return but BEFORE any paid
 * wiki/synthesis stage, so a missing key fails at $0 instead of after a full
 * scrape+synthesis run. These lock that ordering in both directions.
 *
 * Env-test discipline (CLAUDE.md): vi.resetModules() + dynamic import so the
 * env Proxy re-parses a fresh process.env; Reflect.deleteProperty (Biome
 * forbids `delete`). getVoyage stays REAL (spread from ...actual) so the throw
 * comes from the actual absent key, not a hand-rolled mock.
 */

const { searchAnimeMock, fetchByIdMock, walkFranchiseMock, findWikiMock, embedTextsMock } =
  vi.hoisted(() => ({
    searchAnimeMock: vi.fn(),
    fetchByIdMock: vi.fn(),
    walkFranchiseMock: vi.fn(),
    findWikiMock: vi.fn(),
    embedTextsMock: vi.fn(),
  }));

vi.mock("@/lib/research/anilist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/anilist")>();
  return {
    ...actual,
    searchAnime: searchAnimeMock,
    fetchById: fetchByIdMock,
    walkFranchise: walkFranchiseMock,
  };
});
vi.mock("@/lib/research/wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research/wiki")>();
  // findWiki is the FIRST paid wiki stage after the preflight — spying it
  // proves the throw lands before any wiki/synthesis work.
  return { ...actual, findWiki: findWikiMock };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  // getVoyage stays real (from ...actual); embedTexts stubbed as a net so no
  // real embedding call is possible even if the ordering ever regressed.
  return { ...actual, embedTexts: embedTextsMock };
});

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

describe("research Voyage preflight (§4.6 fail-fast ordering)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    searchAnimeMock.mockResolvedValue([MEDIA]);
    fetchByIdMock.mockResolvedValue(MEDIA);
    walkFranchiseMock.mockResolvedValue(WALK);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("a fresh title with no VOYAGE_API_KEY rejects BEFORE any wiki/synthesis call", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { researchTitle } = await import("../research");
    // db must not be touched: the reuse branch (its only pre-preflight reader)
    // is skipped, so the throw is the preflight's, not a DB error.
    const throwingDb = {
      select: () => {
        throw new Error("db must not be touched before the preflight");
      },
    } as unknown as Db;

    await expect(researchTitle(throwingDb, "Test Show")).rejects.toThrow(/VOYAGE_API_KEY/);
    expect(findWikiMock).not.toHaveBeenCalled();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("reuseExisting with a cached profile resolves with no key — the cached path is key-free", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { researchTitle } = await import("../research");
    const existing = {
      id: "test_show",
      title: "Test Show",
      scopeClass: "standard",
      researchProvenance: {
        confidence: 90,
        wikiBase: "https://test.fandom.com/wiki",
        seasonsMerged: 1,
        pagesFetched: 10,
      },
    };
    const cachedDb = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
    } as unknown as Db;

    const report = await researchTitle(cachedDb, "Test Show", { reuseExisting: true });
    expect(report.profileId).toBe("test_show");
    // M3R3 C1: a pre-M3R3 cached row never echoes its ASSERTED number — the
    // legacy floor caps at 75 (with pages). The migration fact rides
    // method:"legacy"; the player-facing gap channel stays clear for a
    // richly-scraped old row, and recency is DERIVED from the walked
    // seasons, never hardcoded.
    expect(report.confidence).toBe(75);
    expect(report.trust.method).toBe("legacy");
    expect(report.trust.coverage_gaps).toHaveLength(0);
    expect(report.trust.post_cutoff).toBe(false);
    expect(report.trust.start_year).toBe(2000);
    // M3R3 C3: the gates run on this row too — a sound stored shape passes
    // them, so clean stays clean. The grounding state is "unknown" because no
    // pass ever ran over a legacy profile, and none can now: the page text it
    // would audit was never stored.
    expect(report.trust.defective).toBe(false);
    expect(report.trust.grounding).toBe("unknown");
    // The cached return precedes the preflight — no key needed, nothing paid.
    expect(findWikiMock).not.toHaveBeenCalled();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  /**
   * M3R3 C3 audit: the legacy path stamped defective:false with empty
   * coverage_gaps for ANY row that fetched pages, so a pre-C3 profile in the
   * exact shape the gates exist to catch reached Session Zero at confidence 75
   * with every trigger in the conductor's disclosure rule silent — while the
   * stored row carried each input the gates needed.
   */
  it("a legacy row in a DEFECTIVE shape is judged from its own stored fields", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { researchTitle } = await import("../research");
    const existing = {
      id: "test_show",
      title: "Test Show",
      scopeClass: "standard",
      // A mechanics IP with no power system — the LitRPG defect, cached.
      profile: {
        ip_mechanics: {
          world_setting: { genre: ["Fantasy", "LitRPG"] },
          stat_mapping: { has_canonical_stats: false },
        },
      },
      researchProvenance: {
        confidence: 90,
        wikiBase: "https://test.fandom.com/wiki",
        seasonsMerged: 1,
        pagesFetched: 20,
      },
    };
    const cachedDb = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
    } as unknown as Db;

    const report = await researchTitle(cachedDb, "Test Show", { reuseExisting: true });
    expect(report.trust.defective).toBe(true);
    // The DEFECT leads the gap list, as it does on the fresh path.
    expect(report.trust.coverage_gaps[0]).toContain(
      "DEFECT: genre/tags imply a game-mechanics power system",
    );
    // The stored page text is gone, so the groundable-text floor sits out —
    // it would fire on every migrated row for a substrate never persisted.
    expect(report.trust.coverage_gaps.join(" | ")).not.toContain("groundable source text");
    // The gates MARK; the legacy floor still caps the number at 75.
    expect(report.confidence).toBe(75);
    expect(report.trust.method).toBe("legacy");
    expect(findWikiMock).not.toHaveBeenCalled();
  });

  /**
   * M3R3 C3 re-audit, findings [2]/[6]/[7]: the rows M3R3 C1 and C2 wrote —
   * the CURRENT production population — carry a `research_trust` that predates
   * `defective`, `grounding` and `field_pages`. Read through a type cast those
   * arrive as undefined behind types promising otherwise, and JSON.stringify
   * drops the keys out of the conductor's profile_health entirely; and because
   * a stored record short-circuited the gates, a LitRPG with no power system
   * kept a clean bill forever. The parse supplies the defaults, and the gates
   * re-run over the stored fields — reading the walked TAGS, since AniList's
   * genre vocabulary contains no mechanics fragment at all.
   */
  const C1_ERA_TRUST = {
    method: "api_wiki",
    derived_confidence: 80,
    sources_consulted: ["anilist", "https://test.fandom.com/wiki"],
    pages_fetched: 20,
    post_cutoff: false,
    field_sources: { world_setting: "wiki_page" },
    coverage_gaps: [],
  };

  const cachedRowWith = (trust: unknown, genre: string[]) => ({
    id: "test_show",
    title: "Test Show",
    scopeClass: "standard",
    profile: {
      ip_mechanics: {
        world_setting: { genre },
        stat_mapping: { has_canonical_stats: false },
      },
      research_trust: trust,
    },
    researchProvenance: {
      confidence: 80,
      wikiBase: "https://test.fandom.com/wiki",
      seasonsMerged: 1,
      pagesFetched: 20,
    },
  });

  const dbReturning = (row: unknown) =>
    ({ select: () => ({ from: () => ({ where: async () => [row] }) }) }) as unknown as Db;

  it("a C1/C2-era stored trust PARSES: the C3 defaults exist and survive JSON.stringify", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { researchTitle } = await import("../research");
    const report = await researchTitle(
      dbReturning(cachedRowWith(C1_ERA_TRUST, ["Fantasy", "Action"])),
      "Test Show",
      { reuseExisting: true },
    );

    // The stored record still rules the numbers — parsing adds, never edits.
    expect(report.trust.method).toBe("api_wiki");
    expect(report.confidence).toBe(80);
    // The keys the conductor's disclosure law reads are all PRESENT. Undefined
    // here is the whole bug: JSON.stringify would delete them silently.
    expect(report.trust.defective).toBe(false);
    expect(report.trust.grounding).toBe("unknown");
    expect(report.trust.field_pages).toEqual({});
    const health = JSON.parse(
      JSON.stringify({
        derived_confidence: report.trust.derived_confidence,
        method: report.trust.method,
        pages_fetched: report.trust.pages_fetched,
        post_cutoff: report.trust.post_cutoff,
        defective: report.trust.defective,
        grounding: report.trust.grounding,
        coverage_gaps: report.trust.coverage_gaps,
      }),
    );
    for (const key of [
      "derived_confidence",
      "method",
      "pages_fetched",
      "post_cutoff",
      "defective",
      "grounding",
      "coverage_gaps",
    ]) {
      expect(health).toHaveProperty(key);
    }
    expect(findWikiMock).not.toHaveBeenCalled();
  });

  it("the gates re-run over a stored-trust row, and the walked TAGS are what fire them", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    // AniList's genre vocabulary carries no mechanics fragment — the LitRPG
    // signal lives in the tags, which the slug door walks and now passes in.
    const litrpg: AniListMedia = {
      ...MEDIA,
      genres: ["Fantasy", "Action"],
      tags: [{ name: "LitRPG", rank: 85, isMediaSpoiler: false }],
    };
    searchAnimeMock.mockResolvedValue([litrpg]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[litrpg.id, litrpg]]),
    } satisfies FranchiseWalk);
    const { researchTitle } = await import("../research");
    const report = await researchTitle(
      dbReturning(cachedRowWith(C1_ERA_TRUST, ["Fantasy", "Action"])),
      "Test Show",
      { reuseExisting: true },
    );

    // A row written before the gates existed is finally marked — the stored
    // record said defective:false by omission, and the shape says otherwise.
    expect(report.trust.defective).toBe(true);
    expect(report.trust.coverage_gaps[0]).toContain(
      "DEFECT: genre/tags imply a game-mechanics power system",
    );
    // The stored text substrate is gone, so the floor sits out here too.
    expect(report.trust.coverage_gaps.join(" | ")).not.toContain("groundable source text");
    // Marking is all that moves: the stored number and method are untouched.
    expect(report.confidence).toBe(80);
    expect(report.trust.method).toBe("api_wiki");
    expect(report.trust.grounding).toBe("unknown");
  });

  it("a stored DEFECT is not duplicated when the gates re-derive it", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const litrpg: AniListMedia = {
      ...MEDIA,
      tags: [{ name: "LitRPG", rank: 85, isMediaSpoiler: false }],
    };
    searchAnimeMock.mockResolvedValue([litrpg]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[litrpg.id, litrpg]]),
    } satisfies FranchiseWalk);
    const defect =
      "DEFECT: genre/tags imply a game-mechanics power system and none survived research — the KA would improvise §4 constraints";
    const { researchTitle } = await import("../research");
    const report = await researchTitle(
      dbReturning(
        cachedRowWith(
          { ...C1_ERA_TRUST, defective: true, grounding: "audited", coverage_gaps: [defect] },
          ["Fantasy"],
        ),
      ),
      "Test Show",
      { reuseExisting: true },
    );

    expect(report.trust.defective).toBe(true);
    expect(report.trust.coverage_gaps.filter((g) => g === defect)).toHaveLength(1);
    // A C3-era record keeps its own audited state — re-running pure gates is
    // not a re-audit.
    expect(report.trust.grounding).toBe("audited");
  });

  it("a MALFORMED stored trust degrades to the legacy floor instead of throwing", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const { researchTitle } = await import("../research");
    // method is not in the enum: the record cannot be trusted at its word.
    const report = await researchTitle(
      dbReturning(cachedRowWith({ ...C1_ERA_TRUST, method: "vibes" }, ["Fantasy"])),
      "Test Show",
      { reuseExisting: true },
    );

    expect(report.trust.method).toBe("legacy");
    // The legacy floor caps the asserted number, exactly as for a row that
    // carried no record at all.
    expect(report.confidence).toBe(75);
    expect(report.trust.grounding).toBe("unknown");
  });

  it("a post-cutoff HOLLOW legacy row reads thin AND post-cutoff — both honesty signals derive", async () => {
    Reflect.deleteProperty(process.env, "VOYAGE_API_KEY");
    const recent: AniListMedia = { ...MEDIA, startDate: { year: 2026 } };
    searchAnimeMock.mockResolvedValue([recent]);
    walkFranchiseMock.mockResolvedValue({
      ...WALK,
      fetched: new Map([[recent.id, recent]]),
    } satisfies FranchiseWalk);
    const { researchTitle } = await import("../research");
    const existing = {
      id: "test_show",
      title: "Test Show",
      scopeClass: "micro",
      researchProvenance: { confidence: 90, wikiBase: null, seasonsMerged: 1, pagesFetched: 0 },
    };
    const cachedDb = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
    } as unknown as Db;

    const report = await researchTitle(cachedDb, "Test Show", { reuseExisting: true });
    // The founding row's own shape: asserted 90, zero pages — derives 25,
    // names the hole, and the recency flag comes from the fresh walk.
    expect(report.confidence).toBe(25);
    expect(report.trust.coverage_gaps.join(" ")).toContain("re-research");
    expect(report.trust.post_cutoff).toBe(true);
    expect(report.trust.start_year).toBe(2026);
  });
});
