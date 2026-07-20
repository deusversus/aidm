/**
 * Fandom/MediaWiki scraper (blueprint §4.6; v3 scrapers/fandom.py carried).
 * Finds the IP's wiki (override map → slug candidates → relevance gate),
 * pulls parsed page HTML, cleans it to markdown-ish text, and classifies
 * categories into the seven canonical page types via one judgment call.
 * v5 simplification of v3's ≤5-round WikiScout tool loop: what the loop
 * bought was category-SIZE checks and category/page PREVIEWS to verify
 * content before committing — if scrape plans misclassify on oddly-named
 * wikis, restoring those probes is the fix, not prompt tuning.
 */

import { STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { z } from "zod";

export const CANONICAL_PAGE_TYPES = [
  "characters",
  "techniques",
  "locations",
  "arcs",
  "factions",
  "items",
  "lore",
] as const;
export type CanonicalPageType = (typeof CANONICAL_PAGE_TYPES)[number];

/** v3's empirical override map, ported whole — each entry is a title where slug-guessing failed. */
const WIKI_URL_OVERRIDES: Record<string, string> = {
  "attack on titan": "https://attackontitan.fandom.com",
  "shingeki no kyojin": "https://attackontitan.fandom.com",
  "my hero academia": "https://myheroacademia.fandom.com",
  "boku no hero academia": "https://myheroacademia.fandom.com",
  "hunter x hunter": "https://hunterxhunter.fandom.com",
  "jujutsu kaisen": "https://jujutsu-kaisen.fandom.com",
  "demon slayer": "https://kimetsu-no-yaiba.fandom.com",
  "kimetsu no yaiba": "https://kimetsu-no-yaiba.fandom.com",
  "fullmetal alchemist": "https://fma.fandom.com",
  "fullmetal alchemist brotherhood": "https://fma.fandom.com",
  "dragon ball": "https://dragonball.fandom.com",
  "dragon ball z": "https://dragonball.fandom.com",
  "dragon ball super": "https://dragonball.fandom.com",
  "one piece": "https://onepiece.fandom.com",
  naruto: "https://naruto.fandom.com",
  "naruto shippuden": "https://naruto.fandom.com",
  bleach: "https://bleach.fandom.com",
  "black clover": "https://blackclover.fandom.com",
  "fairy tail": "https://fairytail.fandom.com",
  "sword art online": "https://swordartonline.fandom.com",
  "re:zero": "https://rezero.fandom.com",
  rezero: "https://rezero.fandom.com",
  "re zero": "https://rezero.fandom.com",
  "re: zero": "https://rezero.fandom.com",
  "re:zero kara hajimeru isekai seikatsu": "https://rezero.fandom.com",
  "re:zero starting life in another world": "https://rezero.fandom.com",
  "re:zero -starting life in another world-": "https://rezero.fandom.com",
  "death note": "https://deathnote.fandom.com",
  "code geass": "https://codegeass.fandom.com",
  "chainsaw man": "https://chainsaw-man.fandom.com",
  "spy x family": "https://spy-x-family.fandom.com",
  "mob psycho 100": "https://mob-psycho-100.fandom.com",
  "one punch man": "https://onepunchman.fandom.com",
  "tokyo ghoul": "https://tokyoghoul.fandom.com",
  "solo leveling": "https://solo-leveling.fandom.com",
  overlord: "https://overlordmaruyama.fandom.com",
  konosuba: "https://konosuba.fandom.com",
  "kono subarashii sekai ni shukufuku wo!": "https://konosuba.fandom.com",
  "kono subarashii sekai ni shukufuku wo": "https://konosuba.fandom.com",
  "god's blessing on this wonderful world!": "https://konosuba.fandom.com",
  "god's blessing on this wonderful world": "https://konosuba.fandom.com",
  frieren: "https://frieren.fandom.com",
  "frieren beyond journey's end": "https://frieren.fandom.com",
  "sousou no frieren": "https://frieren.fandom.com",
  "that time i got reincarnated as a slime": "https://tensura.fandom.com",
  "tensei shitara slime datta ken": "https://tensura.fandom.com",
  "mushoku tensei": "https://mushokutensei.fandom.com",
  "the rising of the shield hero": "https://shield-hero.fandom.com",
  "tate no yuusha no nariagari": "https://shield-hero.fandom.com",
  "is it wrong to try to pick up girls in a dungeon": "https://danmachi.fandom.com",
  danmachi: "https://danmachi.fandom.com",
  "neon genesis evangelion": "https://evangelion.fandom.com",
  "cowboy bebop": "https://cowboybebop.fandom.com",
  "ghost in the shell": "https://ghostintheshell.fandom.com",
  "vinland saga": "https://vinlandsaga.fandom.com",
  "jojo's bizarre adventure": "https://jojo.fandom.com",
  "jojos bizarre adventure": "https://jojo.fandom.com",
  "fire force": "https://fire-force.fandom.com",
  "enen no shouboutai": "https://fire-force.fandom.com",
  "hell's paradise": "https://hells-paradise.fandom.com",
  jigokuraku: "https://hells-paradise.fandom.com",
  "kaiju no. 8": "https://kaiju-no-8.fandom.com",
  dandadan: "https://dandadan.fandom.com",
  berserk: "https://berserk.fandom.com",
  "princess mononoke": "https://ghibli.fandom.com",
  akira: "https://akira.fandom.com",
  // SV1 (2026-07-12): colon/slash/semicolon-titled staples whose real host the
  // slug filter can't reach. The Fate franchise shares one wiki (typemoon —
  // the TYPE-MOON Wiki, high confidence). Oshi no Ko / Steins;Gate hosts match
  // what sanitized derivation already produces, so the override only reorders
  // discovery; the relevance gate + sitename check remain the backstop.
  "fate/zero": "https://typemoon.fandom.com",
  "fate/stay night": "https://typemoon.fandom.com",
  "fate/stay night unlimited blade works": "https://typemoon.fandom.com",
  "fate/stay night: unlimited blade works": "https://typemoon.fandom.com",
  "fate/apocrypha": "https://typemoon.fandom.com",
  "oshi no ko": "https://oshinoko.fandom.com",
  "【oshi no ko】": "https://oshinoko.fandom.com",
  "steins;gate": "https://steins-gate.fandom.com",
  "steins gate": "https://steins-gate.fandom.com",
};

const COURTESY_DELAY_MS = 200;
const TIMEOUT_MS = 15_000;
const STOPWORDS = new Set(["the", "and", "of", "no", "wo", "ni", "wa", "san"]);

async function mwApi<T>(base: string, params: Record<string, string>): Promise<T | null> {
  try {
    // URL construction lives INSIDE the guard (SV1): a malformed base — a colon
    // or slash that survived derivation, or a bad override — must degrade to a
    // skipped probe, never throw the whole research run. findWiki pre-gates
    // discovery candidates (isProbeableBase); this belt also covers the
    // page/category callers that receive an already-validated base.
    const url = new URL(`${base}/api.php`);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * v3's relevance gate: articles > 0, then a title-search hit for ANY title
 * variant (primary), then the sitename-substring check (secondary) — the
 * guard against same-word slug collisions.
 */
export async function checkWikiRelevance(base: string, titles: string[]): Promise<boolean> {
  const stats = await mwApi<{
    query?: { statistics?: { articles?: number }; general?: { sitename?: string } };
  }>(base, { action: "query", meta: "siteinfo", siprop: "statistics|general" });
  if (!stats?.query?.statistics?.articles) return false;

  for (const title of titles) {
    const search = await mwApi<{
      query?: { searchinfo?: { totalhits?: number }; search?: unknown[] };
    }>(base, {
      action: "query",
      list: "search",
      srsearch: title,
      srlimit: "1",
      // Some Fandom MediaWiki versions omit searchinfo unless asked; the
      // result array itself is the fallback signal.
      srinfo: "totalhits",
    });
    const hits = search?.query?.searchinfo?.totalhits ?? search?.query?.search?.length ?? 0;
    if (hits > 0) return true;
  }
  // Secondary gate (v3): a distinctive title word inside the sitename.
  const sitename = stats.query?.general?.sitename?.toLowerCase() ?? "";
  for (const title of titles) {
    const distinctive = title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    if (distinctive.some((w) => sitename.includes(w))) return true;
  }
  return false;
}

/**
 * Hostname-legal slug candidates (SV1, M2-sz-voice.md). Every candidate is
 * lowercased and reduced to [a-z0-9-] BEFORE it can reach a hostname — colons,
 * slashes, semicolons, spaces, and punctuation are token separators, never
 * characters in the output. The old form kept `:` (via `[^a-z0-9\s:-]`), so
 * "Re:ZERO …" derived `https://re:zero.fandom.com`, whose colon `new URL`
 * reads as an invalid port and throws on — the live 2026-07-12 research crash.
 * `full` collapses word tokens ("rezerokara…"); `hyphen` joins them
 * ("re-zero-kara-…"); `preColon` keeps the pre-":" segment (v3's
 * "Title: Subtitle" heuristic, itself sanitized); `firstWord` is the
 * distinctive-word fallback.
 */
export function slugCandidates(title: string): string[] {
  const lower = title.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const full = words.join("");
  const hyphen = words.join("-");
  const preColon = (lower.split(":")[0] ?? "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("");
  const firstWord = words.find((w) => w.length >= 4 && !STOPWORDS.has(w)) ?? "";
  return [...new Set([full, hyphen, preColon, firstWord].filter((s) => s.length >= 3))];
}

/**
 * Hostname-legality gate for a discovery candidate (SV1). Derivation already
 * sanitizes, but a malformed override or an odd alternate title could still
 * yield a base `new URL` rejects — e.g. the live `https://re:zero.fandom.com`,
 * whose colon reads as an invalid port. A candidate that fails this gate is
 * skipped in findWiki, never fatal. Exported for the SV1 regression suite.
 */
export function isProbeableBase(base: string): boolean {
  try {
    const u = new URL(`${base}/api.php`);
    return u.protocol === "https:" && u.port === "" && u.hostname.endsWith(".fandom.com");
  } catch {
    return false;
  }
}

/**
 * Alternate titles (romaji, synonyms) feed BOTH the slug candidates and the
 * relevance probes — v3's empirical lesson: the English title alone misses
 * wikis named for the romaji (kimetsu-no-yaiba) and vice versa.
 */
export async function findWiki(
  title: string,
  alternateTitles: string[] = [],
): Promise<{ base: string; articles: number } | null> {
  const allTitles = [title, ...alternateTitles].filter((t) => t.length >= 3).slice(0, 6);
  const bases: string[] = [];
  for (const t of allTitles) {
    const override = WIKI_URL_OVERRIDES[t.toLowerCase()];
    if (override) bases.push(override);
  }
  for (const t of allTitles) {
    bases.push(...slugCandidates(t).map((s) => `https://${s}.fandom.com`));
  }
  const seen = new Set<string>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    if (!isProbeableBase(base)) {
      // SV1: an invalid candidate is skipped, never a thrown research run.
      console.warn(`[wiki] skipping malformed wiki candidate: ${base}`);
      continue;
    }
    if (await checkWikiRelevance(base, allTitles)) {
      const stats = await mwApi<{ query?: { statistics?: { articles?: number } } }>(base, {
        action: "query",
        meta: "siteinfo",
        siprop: "statistics",
      });
      return { base, articles: stats?.query?.statistics?.articles ?? 0 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page fetch + cleanup (v3 HTML→text discipline)
// ---------------------------------------------------------------------------

/** v3's SECTIONS_TO_STRIP, ported whole; matched as SUBSTRINGS of headings. */
const SECTIONS_TO_STRIP = [
  "manga appearance",
  "anime appearance",
  "references",
  "notes",
  "site navigation",
  "navigation",
  "gallery",
  "image gallery",
  "external links",
  "trivia",
];

/**
 * v3's section-strip semantics: a noise heading consumes everything until a
 * heading of the SAME OR HIGHER level — subordinate h3s under a stripped h2
 * must not leak back in.
 */
export function stripNoiseSections(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skippingLevel = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{2,3})\s*(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const headingText = (heading[2] ?? "").toLowerCase();
      if (skippingLevel > 0 && level <= skippingLevel) skippingLevel = 0;
      if (skippingLevel === 0 && SECTIONS_TO_STRIP.some((n) => headingText.includes(n))) {
        skippingLevel = level;
        continue;
      }
    }
    if (skippingLevel === 0) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanWikiHtml(html: string): string {
  const text = html
    // script/style contents must die WITH their tags (v3 discipline) — the
    // inline TemplateStyles CSS Fandom emits would otherwise be embedded
    // into canon chunks as text.
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<div class="toc[\s\S]*?<\/div>/gi, "")
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**")
    .replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripNoiseSections(text);
}

export interface WikiPage {
  title: string;
  pageType: CanonicalPageType;
  text: string;
  url: string;
}

export async function fetchPage(
  base: string,
  title: string,
  pageType: CanonicalPageType,
): Promise<WikiPage | null> {
  const data = await mwApi<{ parse?: { title: string; text?: { "*": string } } }>(base, {
    action: "parse",
    page: title,
    prop: "text",
    redirects: "true",
    disabletoc: "true",
  });
  const html = data?.parse?.text?.["*"];
  if (!html) return null;
  const text = cleanWikiHtml(html);
  if (text.length < 50) return null;
  return {
    title: data.parse?.title ?? title,
    pageType,
    text,
    url: `${base}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  };
}

export async function listCategories(base: string): Promise<string[]> {
  const data = await mwApi<{ query?: { allcategories?: { "*": string }[] } }>(base, {
    action: "query",
    list: "allcategories",
    aclimit: "500",
  });
  return (data?.query?.allcategories ?? []).map((c) => c["*"]);
}

export async function categoryMembers(
  base: string,
  category: string,
  limit: number,
): Promise<string[]> {
  const data = await mwApi<{ query?: { categorymembers?: { title: string; ns: number }[] } }>(
    base,
    {
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmtype: "page",
      cmlimit: String(Math.min(limit, 500)),
    },
  );
  return (data?.query?.categorymembers ?? []).filter((m) => m.ns === 0).map((m) => m.title);
}

// ---------------------------------------------------------------------------
// Scrape plan (v3 WikiScout, single-shot v5 form)
// ---------------------------------------------------------------------------

const ScrapePlan = z.object({
  categories: z.array(
    z.object({
      wiki_category: z.string(),
      canonical_type: z.enum(CANONICAL_PAGE_TYPES),
      priority: z.number().int().min(1).max(3).describe("1 = scrape first"),
    }),
  ),
  ip_notes: z.string().describe("one or two lines of wiki-specific quirks worth remembering"),
});
export type ScrapePlan = z.infer<typeof ScrapePlan>;

export async function planScrape(title: string, categories: string[]): Promise<ScrapePlan> {
  return callJudgment(DEV_TIER_SELECTION, {
    name: "wiki_scrape_plan",
    schema: ScrapePlan,
    system: [
      "You plan a wiki scrape for a story engine's canon corpus. Map the wiki's",
      "categories onto canonical page types (characters, techniques, locations,",
      "arcs, factions, items, lore). BE GREEDY: prefer the broadest container",
      "per type; include every type the wiki supports.",
      // v3 WikiScout's distilled pitfall record — real misclassifications.
      "COMMON PITFALLS: image/gallery categories ('Character Images', 'Images",
      "by X') contain media files, not articles — ALWAYS SKIP. Template/",
      "navigation and stub/maintenance categories — SKIP. Subset-grouping",
      "categories ('Characters by location') group CHARACTERS, not locations —",
      "classify by what the pages ARE. Single-entity categories ('Ackerman",
      "clan') are individual factions, not containers — only use if no broader",
      "Organizations/Factions category exists. Per-episode/chapter/volume",
      "categories are noise — only a broad Episodes or Story Arcs category.",
      "British spelling is fine ('Organisation' IS a factions category).",
      "IP GUIDANCE: sci-fi often uses Technology/Weapons/Ships for techniques;",
      "fantasy uses Magic/Spells; mecha uses Mobile Suits; Races/Species/",
      "Creatures classify as lore.",
    ].join(" "),
    prompt: `Wiki: ${title}\n\nCategories (up to 500):\n${categories.join("\n")}`,
    effort: "low",
    maxTokens: STRUCTURED_RICH,
  });
}

/**
 * v3's character-quote extractor for voice cards: "..." (20–300 chars) +
 * 「」 (10–300), collected in DOCUMENT ORDER so the cap doesn't starve one
 * quote style when a page is quote-dense.
 */
export function extractQuotes(text: string, cap = 20): string[] {
  const matches = [...text.matchAll(/"([^"\n]{20,300})"|「([^」\n]{10,300})」/g)];
  return matches
    .map((m) => m[1] ?? m[2] ?? "")
    .filter(Boolean)
    .slice(0, cap);
}
