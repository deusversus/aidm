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
    expect(report.confidence).toBe(90);
    // The cached return precedes the preflight — no key needed, nothing paid.
    expect(findWikiMock).not.toHaveBeenCalled();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });
});
