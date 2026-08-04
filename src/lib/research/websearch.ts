/**
 * The websearch fallback chain (M3R3 C2; v3's three levels carried, wired
 * DELIBERATELY this time — v3's terminal fallback was orphaned by a rewrite
 * and nobody noticed until the plan's archaeology found the dead call sites).
 *
 * Levels, in the order research.ts walks them:
 *   A. Identity rescue — AniList has no match: search resolves what the
 *      player actually means, then AniList retries on the rescued titles.
 *   B. Web-only identity — AniList AND rescue both miss but live sources
 *      prove the work exists: a synthetic media identity is built from
 *      search so the pipeline can run at all (v3's ResolvedAnime with
 *      anilist_id=None). §8's guard holds — existence is still VERIFIED,
 *      by citation instead of by API row.
 *   C. Topic supplement — AniList in hand but the wiki is missing or thin:
 *      per-organ searches produce WikiPage-shaped pages (origin
 *      "web_search") that feed the SAME synthesis, corpus, and trust paths
 *      as scraped pages. One contract, honestly labeled.
 *
 * Terminal recall stays what C1 made it: when search itself is unavailable
 * or dry, research proceeds on AniList metadata alone and deriveTrust says
 * so out loud — the fallback that can't fire silently.
 *
 * Every call here is free-prose search (callSearch) + a separate structured
 * shaping call (callJudgment) — the house law (tools never share a request
 * with output_config) and v3's own two-call lesson, kept.
 */

import { STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment, callSearch } from "@/lib/llm/calls";
import { z } from "zod";
import type { AniListMedia } from "./anilist";
import { RESEARCH_SELECTION } from "./synthesize";
import type { CanonicalPageType, WikiPage } from "./wiki";

/**
 * v3's source-prioritization ladder (ANIME_RESEARCH_PROMPT, carried whole):
 * the search model weighs sources instead of averaging them.
 */
const SOURCE_TRUST_LADDER = [
  "Source prioritization:",
  "HIGH TRUST (primary): wikipedia.org, myanimelist.net, anilist.co, anidb.net, official publisher/streaming pages.",
  "MEDIUM TRUST (supplement, verify against HIGH): fandom.com wikis, animenewsnetwork.com, crunchyroll.com, reddit.com.",
  "LOW TRUST (verify against multiple others): everything else, especially SEO content farms.",
  "If sources conflict, prefer HIGH trust. Never invent details no source carries.",
].join(" ");

// ---------------------------------------------------------------------------
// Level A/B: identity
// ---------------------------------------------------------------------------

export const WebIdentity = z.object({
  /** Live sources verify this work exists (citations, not vibes). */
  exists: z.boolean(),
  /** Candidate official titles, best first — fed back to AniList search. */
  candidate_titles: z.array(z.string()),
  official_title: z.string(),
  romaji_title: z.string(),
  media_type: z.enum(["anime", "manga", "manhwa", "light_novel", "web_novel", "unknown"]),
  start_year: z.number().int(),
  genres: z.array(z.string()),
  tags: z.array(z.string()),
  synopsis: z.string(),
  status: z.enum(["ongoing", "completed", "unknown"]),
  notes: z.string(),
});
export type WebIdentity = z.infer<typeof WebIdentity>;

export interface IdentityRescue {
  identity: WebIdentity;
  searchedUrls: { url: string; title: string }[];
  searchCount: number;
}

/**
 * Level A's search: what IS this title? Used both to rescue an AniList miss
 * (retry search on candidate_titles) and, when AniList stays dry, as the
 * Level B identity substrate.
 */
export async function searchIdentity(rawTitle: string): Promise<IdentityRescue> {
  const search = await callSearch(RESEARCH_SELECTION, {
    name: "research_search_identity",
    phase: "research",
    system: `You research anime/manga/light-novel identity for a story studio. ${SOURCE_TRUST_LADDER}`,
    prompt: [
      `A player asked for a work titled or nicknamed: "${rawTitle}".`,
      "Find what this actually is: the official English title, romaji title,",
      "media type, first release/airing year, genres, community tags, a short",
      "synopsis, and publication status. If it recently got an adaptation,",
      "note both the source work and the adaptation. If you cannot find any",
      "real work behind this name, say so plainly — never invent one.",
      "IMPORTANT: titles must be returned EXACTLY as officially written —",
      "never shorten or truncate them; light-novel titles are intentionally",
      "long. When several works share the name, list each as a candidate.",
    ].join(" "),
    maxUses: 4,
    effort: "low",
  });
  const identity = await callJudgment(RESEARCH_SELECTION, {
    name: "research_identity_shape",
    phase: "research",
    schema: WebIdentity,
    system:
      "Shape the research notes into the identity record. exists=true ONLY when the notes cite real sources for a real work — when in doubt, false. candidate_titles: official titles best-first, EXACTLY as written (never truncated). Unknown numeric fields: 0. Unknown strings: empty.",
    prompt: `Player's input: "${rawTitle}"\n\nResearch notes:\n${search.text.slice(0, 12_000)}\n\nSources seen:\n${search.searchedUrls.map((u) => `- ${u.title}: ${u.url}`).join("\n")}`,
    effort: "low",
    maxTokens: STRUCTURED_RICH,
  });
  // Level B's whole §8 justification is existence-by-CITATION. When the
  // search consulted nothing — every query errored, or the model answered
  // without firing one — a shaped exists=true is the model's memory, not
  // proof, and research would mint a synthetic media identity out of recall.
  // The candidates survive the demotion because Level A re-verifies them
  // against AniList independently; only the existence CLAIM is forced down.
  const cited = search.searchedUrls.length > 0 || search.citations.length > 0;
  return {
    identity: { ...identity, exists: identity.exists && cited },
    searchedUrls: search.searchedUrls,
    searchCount: search.searchCount,
  };
}

/**
 * Level B: the synthetic media identity — the pipeline's AniListMedia shape
 * built from cited search instead of an API row. id 0 marks it synthetic;
 * nothing downstream persists anilist_id when it is 0.
 */
export function mediaFromWebIdentity(identity: WebIdentity): AniListMedia {
  return {
    id: 0,
    idMal: null,
    title: {
      english: identity.official_title || null,
      romaji: identity.romaji_title || null,
      native: null,
    },
    synonyms: identity.candidate_titles.filter(
      (t) => t !== identity.official_title && t !== identity.romaji_title,
    ),
    format: identity.media_type === "anime" ? "TV" : null,
    status: identity.status === "completed" ? "FINISHED" : "RELEASING",
    episodes: null,
    description: identity.synopsis || null,
    genres: identity.genres,
    tags: identity.tags.map((name) => ({ name, rank: 60, isMediaSpoiler: false })),
    averageScore: null,
    popularity: null,
    characters: { edges: [] },
    relations: { edges: [] },
    studios: { nodes: [] },
    startDate: identity.start_year > 0 ? { year: identity.start_year } : null,
    season: null,
    source: null,
    isAdult: false,
  };
}

// ---------------------------------------------------------------------------
// Level C: topic searches → WikiPage-shaped pages
// ---------------------------------------------------------------------------

/**
 * v3's TOPIC_QUERY_TEMPLATES, mapped onto the seven canonical page types so
 * the search harvest feeds intent-mapped retrieval like any scraped page.
 */
export const SEARCH_TOPICS: { key: string; pageType: CanonicalPageType; query: string }[] = [
  {
    key: "power_system",
    pageType: "techniques",
    query: "power system mechanics abilities rules limitations costs tiers progression",
  },
  {
    key: "characters",
    pageType: "characters",
    query:
      "main characters personalities speech patterns notable quotes catchphrases relationships",
  },
  {
    key: "world",
    pageType: "locations",
    query: "world setting locations factions organizations geography history",
  },
  {
    key: "story",
    pageType: "arcs",
    query: "story arcs plot summary major events in order spoilers included",
  },
  {
    key: "stats",
    pageType: "lore",
    query:
      "stat system status windows levels ranks numeric measurements items artifacts terminology",
  },
];

export interface TopicSearchResult {
  pages: WikiPage[];
  searchedUrls: { url: string; title: string }[];
  /** topic key → URLs that actually backed that topic's page (field_pages grain). */
  topicUrls: Record<string, string[]>;
  searchCount: number;
}

/**
 * One search per requested topic, SEQUENTIAL on purpose (v3's trap record:
 * unbounded parallel search calls trip 429s immediately). A dry or failed
 * topic is skipped, never fatal — the terminal-recall path must stay
 * reachable when the whole chain is dark.
 */
export async function searchTopics(
  title: string,
  topics: readonly { key: string; pageType: CanonicalPageType; query: string }[],
): Promise<TopicSearchResult> {
  const result: TopicSearchResult = { pages: [], searchedUrls: [], topicUrls: {}, searchCount: 0 };
  const seen = new Set<string>();
  for (const topic of topics) {
    try {
      const r = await callSearch(RESEARCH_SELECTION, {
        name: `research_search_${topic.key}`,
        phase: "research",
        system: [
          "You research source material for a licensed tabletop adaptation",
          "studio. Be factual and SPECIFIC to this work — names, terms, numbers,",
          "and actual quoted lines where sources carry them; generic genre",
          `prose is useless. ${SOURCE_TRUST_LADDER}`,
        ].join(" "),
        prompt: `Research ${title}: ${topic.query}. Write what the sources actually establish, organized and thorough.`,
        maxUses: 3,
        effort: "low",
      });
      result.searchCount += r.searchCount;
      const citedUrls = [...new Set(r.citations.map((c) => c.url))];
      const backing = citedUrls.length > 0 ? citedUrls : r.searchedUrls.map((u) => u.url);
      // Length was never proof. An uncited answer of the right SIZE is
      // parametric recall wearing a lab coat — the model writing from memory
      // while the page it becomes is stamped origin "web_search" and counted
      // as a consulted source. That asserted provenance is the exact defect
      // this milestone exists to kill, so a page needs BOTH substance and a
      // live source that backed it.
      const grounded = r.citations.length > 0 || r.searchedUrls.length > 0;
      if (r.text.trim().length < 200 || !grounded) {
        console.warn(`[websearch] topic "${topic.key}" produced no grounded page — skipped`, {
          chars: r.text.trim().length,
          citations: r.citations.length,
          searched: r.searchedUrls.length,
          errors: r.errors,
        });
        continue;
      }
      // A truncated topic still becomes a page when it clears that gate: the
      // prose it did produce is cited prose. The truncation surfaces as
      // callSearch's warn + flag; C3's grounding pass is the consumer that
      // will care how complete a page is, not this harvest.
      result.pages.push({
        title: `${title} — ${topic.key} (web research)`,
        pageType: topic.pageType,
        text: r.text,
        url: backing[0] ?? "web_search",
        origin: "web_search",
      });
      result.topicUrls[topic.key] = backing;
      for (const u of r.searchedUrls) {
        if (!seen.has(u.url)) {
          seen.add(u.url);
          result.searchedUrls.push(u);
        }
      }
    } catch (err) {
      console.warn(`[websearch] topic "${topic.key}" failed — skipped, chain continues`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * The thin-scrape supplement selector (v3 L1266-1294 translated): only the
 * organs the scrape starved get a search — a wiki with rich technique pages
 * but no quotes buys ONE characters search, not five.
 */
export function missingTopics(byTypeCounts: Record<CanonicalPageType, number>) {
  return SEARCH_TOPICS.filter((t) => {
    if (t.key === "power_system") return byTypeCounts.techniques === 0;
    if (t.key === "characters") return byTypeCounts.characters === 0;
    if (t.key === "world") return byTypeCounts.locations === 0 && byTypeCounts.factions === 0;
    if (t.key === "story") return byTypeCounts.arcs === 0;
    if (t.key === "stats") return byTypeCounts.lore === 0 && byTypeCounts.items === 0;
    return false;
  });
}
