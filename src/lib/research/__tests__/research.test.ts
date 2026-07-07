import { describe, expect, it } from "vitest";
import {
  type AniListMedia,
  continuityBase,
  mergeSeasons,
  pickBestMatch,
  relevantTags,
} from "../anilist";
import { chunkPage } from "../corpus";
import { classifyScope, profileSlug } from "../research";
import { cleanWikiHtml, extractQuotes, stripNoiseSections } from "../wiki";

const media = (overrides: Partial<AniListMedia>): AniListMedia => ({
  id: 1,
  idMal: 1,
  title: { romaji: "Test", english: "Test", native: null },
  synonyms: [],
  format: "TV",
  status: "FINISHED",
  episodes: 12,
  description: "d",
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
  ...overrides,
});

describe("pickBestMatch (v3 disambiguation ladder)", () => {
  it("prefers TV over MOVIE regardless of popularity, then popularity within format", () => {
    const tv = media({ id: 1, format: "TV", popularity: 100 });
    const movie = media({ id: 2, format: "MOVIE", popularity: 99_999 });
    const tvBig = media({ id: 3, format: "TV", popularity: 5_000 });
    expect(pickBestMatch([movie, tv, tvBig])?.id).toBe(3);
  });

  it("returns null on empty candidates (existence guard input)", () => {
    expect(pickBestMatch([])).toBeNull();
  });
});

describe("relevantTags (§4.6 primary Treatment signal)", () => {
  it("drops spoiler tags and sub-floor ranks", () => {
    const m = media({
      tags: [
        { name: "Noir", rank: 80, isMediaSpoiler: false },
        { name: "Twist", rank: 90, isMediaSpoiler: true },
        { name: "Faint", rank: 10, isMediaSpoiler: false },
      ],
    });
    expect(relevantTags(m)).toEqual([{ name: "Noir", rank: 80 }]);
  });
});

describe("mergeSeasons (v3 series merge)", () => {
  it("sums episodes, unions tags at max rank, unions characters, takes earliest status", () => {
    const s1 = media({
      id: 1,
      episodes: 13,
      status: "FINISHED",
      tags: [{ name: "Noir", rank: 60, isMediaSpoiler: false }],
      characters: {
        edges: [{ role: "MAIN", node: { name: { full: "Ayaka", native: null } } }],
      },
    });
    const s2 = media({
      id: 2,
      episodes: 11,
      status: "RELEASING",
      genres: ["Action", "Drama"],
      tags: [
        { name: "Noir", rank: 85, isMediaSpoiler: false },
        { name: "Space", rank: 70, isMediaSpoiler: false },
      ],
      characters: {
        edges: [
          { role: "MAIN", node: { name: { full: "Ayaka", native: null } } },
          { role: "MAIN", node: { name: { full: "Jun", native: null } } },
        ],
      },
    });
    const merged = mergeSeasons([s1, s2]);
    expect(merged.episodes).toBe(24);
    expect(merged.tags.find((t) => t.name === "Noir")?.rank).toBe(85);
    expect(merged.tags.map((t) => t.name).sort()).toEqual(["Noir", "Space"]);
    expect(merged.characters.edges).toHaveLength(2);
    expect(merged.status).toBe("RELEASING");
    expect(merged.genres).toEqual(["Action", "Drama"]);
  });
});

describe("classifyScope (v3 thresholds, made functional)", () => {
  it("maps article counts to classes", () => {
    expect(classifyScope(0)).toBe("micro");
    expect(classifyScope(50)).toBe("standard");
    expect(classifyScope(300)).toBe("complex");
    expect(classifyScope(301)).toBe("epic");
  });
});

describe("profileSlug", () => {
  it("slugs match the canon_chunks key convention", () => {
    expect(profileSlug("Cowboy Bebop")).toBe("cowboy_bebop");
    expect(profileSlug("Re:ZERO -Starting Life-")).toBe("re_zero_starting_life");
  });
});

describe("cleanWikiHtml (v3 noise discipline)", () => {
  it("strips infoboxes/tables, keeps headers and emphasis, drops noise sections", () => {
    const html = `
      <aside class="portable-infobox">STATS</aside>
      <table><tr><td>nav</td></tr></table>
      <h2>History</h2><p>Born on <b>Mars</b>.</p>
      <h2>Gallery</h2><p>img img img</p>`;
    const text = cleanWikiHtml(html);
    expect(text).not.toContain("STATS");
    expect(text).not.toContain("nav");
    expect(text).toContain("## History");
    expect(text).toContain("**Mars**");
    expect(text).not.toMatch(/img img img/);
  });

  it("kills script/style CONTENTS — inline CSS must never reach canon chunks", () => {
    const html = `<style data-mw-deduplicate="TemplateStyles:r123">.mw-parser-output .fake{display:none}</style>
      <script>window.tracking()</script><p>Real prose.</p>`;
    const text = cleanWikiHtml(html);
    expect(text).not.toContain("mw-parser-output");
    expect(text).not.toContain("tracking");
    expect(text).toContain("Real prose.");
  });

  it("noise headings match as substrings and consume subordinate headings", () => {
    const text = [
      "## Manga Appearances List",
      "chapter noise",
      "### Volume 3",
      "more noise",
      "## History",
      "keep this",
    ].join("\n");
    const cleaned = stripNoiseSections(text);
    expect(cleaned).not.toContain("chapter noise");
    expect(cleaned).not.toContain("more noise");
    expect(cleaned).toContain("keep this");
  });
});

describe("continuity grouping (v3 SEASON_VARIANT_RE)", () => {
  it("collapses season variants but separates distinct continuities", () => {
    expect(continuityBase("Naruto")).toBe("naruto");
    expect(continuityBase("Attack on Titan Season 3")).toBe("attack on titan");
    expect(continuityBase("Mob Psycho 100 II")).toBe("mob psycho 100 ii"); // roman numerals: distinct base, v3-faithful
    expect(continuityBase("Re:Zero 2nd Season")).toBe("re:zero");
    expect(continuityBase("Vinland Saga Season 2: Slave Arc")).toBe("vinland saga");
    // The load-bearing split: Shippuden is NOT Naruto.
    expect(continuityBase("Naruto Shippuden")).not.toBe(continuityBase("Naruto"));
  });
});

describe("extractQuotes (voice-card source)", () => {
  it("bounds lengths, includes Japanese brackets, caps output", () => {
    const short = '"hi"';
    const good = '"This one is long enough to count as a quote."';
    const jp = "「これは日本語の引用です」";
    const text = `${short} ${good} ${jp} ${Array.from({ length: 30 }, (_, i) => `"Quote number ${i} padded to length!!"`).join(" ")}`;
    const quotes = extractQuotes(text, 20);
    expect(quotes).toContain("This one is long enough to count as a quote.");
    expect(quotes).toContain("これは日本語の引用です");
    expect(quotes).not.toContain("hi");
    expect(quotes.length).toBeLessThanOrEqual(20);
  });
});

describe("chunkPage (corpus chunking)", () => {
  it("merges small sections and splits oversized ones near the target", () => {
    const small = "## A\nshort\n\n## B\nalso short";
    const chunksSmall = chunkPage({
      title: "T",
      pageType: "lore",
      url: "u",
      text: small,
    });
    expect(chunksSmall).toHaveLength(1);

    const big = `## Long\n${"para ".repeat(400)}\n\n${"para ".repeat(400)}\n\n${"para ".repeat(400)}`;
    const chunksBig = chunkPage({ title: "T", pageType: "lore", url: "u", text: big });
    expect(chunksBig.length).toBeGreaterThan(1);
    for (const c of chunksBig) {
      expect(c.content.length / 4).toBeLessThan(1_600);
    }
  });
});
