/**
 * The research pipeline orchestrator (blueprint §4.6, §8; v3's API-first
 * pipeline carried). Existence-validation is the SZ conductor's guard: a
 * title neither AniList nor live web search can verify throws — the engine
 * never confirms a season it cannot verify. M3R3 C2 walks v3's three
 * fallback levels around that guard (websearch.ts): identity rescue, the
 * web-only identity, and the topic supplement, each honestly labeled in the
 * trust record rather than laundered into wiki credit.
 */

import type { Db } from "@/lib/db";
import { profiles } from "@/lib/db/schema";
import { getVoyage } from "@/lib/llm/voyage";
import { type FieldSource, Profile, ResearchTrust } from "@/lib/types/profile";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  type AniListMedia,
  fetchById,
  mergeSeasons,
  pickBestMatch,
  relevantTags,
  searchAnime,
  walkFranchise,
} from "./anilist";
import { writeCorpus } from "./corpus";
import {
  DEFAULT_STAT_MAPPING,
  type GroundingClaim,
  SYNTHESIS_FEEDS,
  type SynthesisFeedSpec,
  groundProfile,
  interpretTonal,
  synthesizeNarrative,
  synthesizePowerSystem,
  synthesizeStatMapping,
  synthesizeVoiceCards,
} from "./synthesize";
import {
  KNOWLEDGE_CUTOFF_YEAR,
  type OrganSource,
  RICH_CONTENT_CHARS,
  buildFieldSources,
  coverageGates,
  deriveTrust,
  mechanicsImplied,
} from "./trust";
import {
  type IdentityRescue,
  SEARCH_TOPICS,
  type WebIdentity,
  mediaFromWebIdentity,
  missingTopics,
  searchIdentity,
  searchTopics,
} from "./websearch";
import {
  CANONICAL_PAGE_TYPES,
  type CanonicalPageType,
  type WikiPage,
  categoryMembers,
  extractQuotes,
  fetchPage,
  findWiki,
  listCategories,
  planScrape,
} from "./wiki";

export type ScopeClass = "micro" | "standard" | "complex" | "epic";

/** v3's deterministic classifier — v5 makes it functional (page caps). */
export function classifyScope(wikiArticles: number): ScopeClass {
  if (wikiArticles === 0) return "micro";
  if (wikiArticles <= 50) return "standard";
  if (wikiArticles <= 300) return "complex";
  return "epic";
}

/** Total page budget per scope class (M1 caps; v3 scraped up to 500/type). */
const PAGE_BUDGET: Record<ScopeClass, number> = {
  micro: 0,
  standard: 40,
  complex: 80,
  epic: 120,
};

/**
 * Below this many scraped pages the wiki counts as thin even when its text is
 * long (M3R3 C2): v3's supplement fired on 1-2 page TYPES surviving the plan;
 * v5's harvest is page-grained, so the same starvation shows up as a handful
 * of pages spread across the seven organs.
 */
const THIN_SCRAPE_PAGES = 8;

export function profileSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Loose title key for cache matching — case- and punctuation-insensitive, so
 * "Re:ZERO -Starting Life-", "re zero starting life", and the stored slug
 * "re_zero_starting_life" all collide on purpose.
 */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface ResearchReport {
  profileId: string;
  title: string;
  scope: ScopeClass;
  seasonsMerged: number;
  wikiBase: string | null;
  pagesFetched: number;
  chunksWritten: number;
  confidence: number;
  notes: string[];
  /** M3R3 C1: the derived trust record — the conductor's honesty surface. */
  trust: ResearchTrust;
}

export interface ResearchOptions {
  /** Dev iteration: skip corpus re-embedding (profile/synthesis only). */
  skipCorpus?: boolean;
  /**
   * Pin the AniList entry (the SZ conductor's disambiguation seam, §8):
   * when set, search is skipped and this id is researched directly.
   */
  anilistId?: number;
  /**
   * Return the stored profile when one exists (§8: profiles cache
   * permanently — the conductor never re-buys research). The AniList
   * identity resolution + franchise walk still run (free, and the
   * disambiguation notes must surface every time); on an AniList MISS the
   * alias probe answers from cache before the paid identity rescue fires.
   * Everything paid — search, scrape, synthesis, embedding — is skipped.
   * The CLI re-researches.
   */
  reuseExisting?: boolean;
}

type ProfileRow = typeof profiles.$inferSelect;

/**
 * A claim's evidence block: the pages that FED it, clipped through the SAME
 * feed spec its synthesis call read them through (M3R3 C3 + re-audit).
 * Parity is by construction — both sides read SYNTHESIS_FEEDS — because two
 * literals that merely agree today drift tomorrow, and this one already did:
 * evidence clipped to 3 × 800 against a power system synthesized from 5 ×
 * 1,000 demoted, by construction, any system built from technique page 4.
 *
 * Exported and pure so the parity itself is testable without buying a call.
 */
export function claimEvidence(feed: WikiPage[], spec: SynthesisFeedSpec): string {
  return feed
    .slice(0, spec.pages)
    .map((p) => `## ${p.title}\n${p.text.slice(0, spec.chars)}`)
    .join("\n\n");
}

/**
 * The cached-profile return (§8). Shared by BOTH cache doors — the slug
 * lookup and the alias probe that guards the paid identity rescue — so the
 * legacy-trust floor is derived in exactly one place.
 */
function cachedReport(
  existing: ProfileRow,
  newestStartYear: number | null,
  notes: string[],
  tagNames: string[],
): ResearchReport {
  const prov = (existing.researchProvenance ?? {}) as {
    confidence?: number;
    wikiBase?: string | null;
    seasonsMerged?: number;
    pagesFetched?: number;
  };
  notes.push("profile cached (§8) — paid research skipped");
  // M3R3 C1: a cached profile's trust rides the stored record; a
  // pre-M3R3 row derives a LEGACY floor from its own provenance — a
  // hollow row (pagesFetched 0) reads THIN, never its asserted number
  // (the founding defect shipped at 90 with zero pages).
  const storedProfile = existing.profile as {
    research_trust?: unknown;
    ip_mechanics?: {
      power_system?: unknown;
      stat_mapping?: { has_canonical_stats?: boolean };
      world_setting?: { genre?: string[] };
    };
  } | null;
  // PARSE, never cast (M3R3 C3 re-audit). `profiles.profile` is bare jsonb —
  // nothing validates it between the select and here — so a C1/C2-era record
  // read through a type assertion arrives with `defective`/`grounding`/
  // `field_pages` UNDEFINED behind types that promise otherwise, and
  // JSON.stringify then drops those keys out of the conductor's
  // profile_health entirely. Parsing applies the schema defaults instead.
  // A record that cannot parse falls through to the legacy floor below rather
  // than throwing: a malformed row must degrade to the honest, conservative
  // number, never take down a cache read that costs nothing.
  let parsedTrust: ResearchTrust | undefined;
  if (storedProfile?.research_trust !== undefined) {
    try {
      parsedTrust = ResearchTrust.parse(storedProfile.research_trust);
    } catch (err) {
      console.warn("[research] stored research_trust failed to parse — deriving the legacy floor", {
        profileId: existing.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const storedTrust = parsedTrust;
  const legacyPages = prov.pagesFetched ?? 0;
  // THE GATES RUN OVER EVERY CACHED ROW that is not already marked (M3R3 C3
  // audit + re-audit). The row itself carries every input the mechanics rules
  // need, they are pure and idempotent, and they cost nothing — so a C3-clean
  // row re-derives clean while a C1/C2-era LitRPG with power_system null,
  // written before the gates existed, is finally marked. Without this a 2019
  // LitRPG reached Session Zero at confidence 75 with an empty gap list and
  // defective:false — the exact shape the gates exist to catch, with every
  // trigger in the conductor's disclosure rule silent.
  const legacyMechanics = storedProfile?.ip_mechanics;
  const gateDefects =
    storedTrust?.defective === true
      ? []
      : coverageGates({
          // The stored genre list can only ever be AniList's fixed genre
          // vocabulary (Action/Adventure/Fantasy/…), which contains no
          // mechanics fragment at all — genres alone made this gate dead code.
          // The signal lives in TAGS, which the caller has walked and passes
          // in. (The alias-probe door has no AniList row and passes none; its
          // Level B rows carry free-form web genres, which DO trip the
          // fragments, so that door is not blind either.)
          mechanicsImplied: mechanicsImplied(legacyMechanics?.world_setting?.genre ?? [], tagNames),
          powerSystemPresent: !!legacyMechanics?.power_system,
          statsCanonical: legacyMechanics?.stat_mapping?.has_canonical_stats === true,
          contentChars: 0,
          pagesFetched: legacyPages,
          // The row keeps no page TEXT, so the groundable-text floor has
          // nothing to measure and would fire on every migrated profile. The
          // hollow case it exists to catch is already the pagesFetched-0 gap
          // below.
          skipTextFloor: true,
        }).defects;
  const trust: ResearchTrust = storedTrust
    ? {
        ...storedTrust,
        // Newly-derived DEFECTs lead, as everywhere else; a gate that already
        // spoke in the stored record is not made to say it twice.
        coverage_gaps: [
          ...gateDefects.filter((d) => !storedTrust.coverage_gaps.includes(d)),
          ...storedTrust.coverage_gaps,
        ],
        defective: storedTrust.defective || gateDefects.length > 0,
      }
    : ({
        method: "legacy",
        derived_confidence: legacyPages > 0 ? Math.min(prov.confidence ?? 60, 75) : 25,
        sources_consulted: prov.wikiBase ? [prov.wikiBase] : [],
        pages_fetched: legacyPages,
        // Derived, never asserted, even here: when identity resolution found a
        // row, the seasons it walked carry the same recency signal the fresh
        // path reads. The alias-probe door has no row to walk, so a legacy
        // record arriving through it honestly derives none.
        post_cutoff: newestStartYear !== null && newestStartYear >= KNOWLEDGE_CUTOFF_YEAR,
        ...(newestStartYear !== null ? { start_year: newestStartYear } : {}),
        field_sources: {},
        field_pages: {},
        // coverage_gaps is the PLAYER-facing channel — only real holes in
        // what's known about the IP belong here. The migration fact rides
        // method:"legacy"; a richly-scraped old row is not a hole. DEFECTs
        // lead, as everywhere else.
        coverage_gaps: [
          ...gateDefects,
          ...(legacyPages > 0
            ? []
            : [
                "pre-M3R3 profile built from ZERO fetched pages — every field is unlabeled model recall; re-research recommended",
              ]),
        ],
        defective: gateDefects.length > 0,
        // The pass predates this row and cannot be run over it now: the page
        // text it would audit was never stored.
        grounding: "unknown",
      } satisfies ResearchTrust);
  return {
    profileId: existing.id,
    title: existing.title,
    scope: (existing.scopeClass ?? "standard") as ScopeClass,
    seasonsMerged: prov.seasonsMerged ?? 0,
    wikiBase: prov.wikiBase ?? null,
    pagesFetched: legacyPages,
    chunksWritten: 0,
    confidence: trust.derived_confidence,
    notes,
    trust,
  };
}

/**
 * The alias cache probe (M3R3 C2). The identity rescue it guards is a PAID
 * search (callSearch + a shaping call), and §8 says the conductor never
 * re-buys research — so the cache is asked BEFORE the money. The rescue's own
 * answer cannot be the only key either: the shaping call is free to return
 * "Phantom Work" on one turn and "Phantom Work: The Animation" on the next,
 * and that drift misses the slug, mints a DUPLICATE profiles row, and flips
 * the compiler's hybrid switch under a campaign already in play. So the match
 * runs on the PLAYER's own words, loosely, against every stored id, title,
 * and alternate title. A full-table scan is fine at this scale — profiles are
 * per-IP (tens of rows), and this fires once per call, on the AniList-miss
 * path only.
 */
async function probeAliasCache(db: Db, rawTitle: string): Promise<ProfileRow | null> {
  const key = titleKey(rawTitle);
  if (!key) return null;
  const rows = await db.select().from(profiles);
  for (const row of rows) {
    const stored = row.profile as {
      alternate_titles?: unknown;
      research_trust?: { method?: unknown };
    } | null;
    // PRIVATE WORLDS NEVER LEAVE THEIR TABLE (M3R3 C4b). `profiles` is a
    // shared cross-campaign cache, and the SZ compiler writes a synthesized
    // original world into it under the world's own NAME — which is exactly
    // what this door matches on. Without this filter, one table's invention
    // would be served to another campaign as cached "research" at confidence
    // 95 ("let's play in the Kettle Reach", a name collision, a second
    // player). §8's cache law covers RESEARCHED sources; a private world is
    // not one, and its row is campaign-scoped for this reason. The slug door
    // upstream needs no equivalent guard — it looks up `profileSlug(title)`
    // by primary key, and no title a player types slugs to `original_<uuid>`.
    if (stored?.research_trust?.method === "player_vision") continue;
    const alternates = stored?.alternate_titles;
    const candidates: unknown[] = [
      row.id,
      row.title,
      ...(Array.isArray(alternates) ? alternates : []),
    ];
    if (candidates.some((t) => typeof t === "string" && titleKey(t) === key)) return row;
  }
  return null;
}

export async function researchTitle(
  db: Db,
  rawTitle: string,
  options: ResearchOptions = {},
): Promise<ResearchReport> {
  const notes: string[] = [];

  // 1. Identity + existence validation (§8 guard) — or a pinned entry.
  let best = options.anilistId
    ? await fetchById(options.anilistId)
    : pickBestMatch(await searchAnime(rawTitle));

  // LEVEL A (M3R3 C2) — identity rescue. AniList indexes by official title;
  // players type nicknames, abbreviations, and the source novel's name. Live
  // search resolves what they MEAN, then AniList is asked again. The §8 guard
  // is not loosened here — it moves one step later.
  let rescue: IdentityRescue | null = null;
  if (!best && !options.anilistId) {
    if (options.reuseExisting) {
      const cached = await probeAliasCache(db, rawTitle);
      // No AniList row means no season walk, so there is no fresh recency
      // signal to hand the legacy floor — a stored record carries its own —
      // and no tag list either. The mechanics gate falls back to the stored
      // genres, which on this door are a Level B row's free-form WEB genres
      // ("LitRPG", "dungeon crawler"), not AniList's closed vocabulary — so
      // the gate still has real signal to read here.
      if (cached) return cachedReport(cached, null, notes, []);
    }
    try {
      rescue = await searchIdentity(rawTitle);
    } catch (err) {
      console.warn("[research] identity rescue search failed — falling through to the §8 guard", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const candidate of (rescue?.identity.candidate_titles ?? []).slice(0, 3)) {
      const retried = pickBestMatch(await searchAnime(candidate));
      if (retried) {
        best = retried;
        const resolvedTitle = retried.title.english ?? retried.title.romaji ?? candidate;
        notes.push(`identity resolved via web search: "${rawTitle}" → "${resolvedTitle}"`);
        break;
      }
    }
  }
  // LEVEL B — no AniList row anywhere, but live sources prove the work
  // exists: the pipeline runs on a synthetic identity (v3's ResolvedAnime
  // with anilist_id=None). Existence is still VERIFIED, by citation.
  const webIdentity: WebIdentity | null = !best && rescue?.identity.exists ? rescue.identity : null;

  let media: AniListMedia;
  let title: string;
  const seasons: AniListMedia[] = [];
  if (best) {
    title = best.title.english ?? best.title.romaji ?? rawTitle;
    // 2. Franchise walk → merge ONLY the root's continuity group (v3's
    //    SEASON_VARIANT_RE discipline: Shippuden is not Naruto; the other
    //    groups surface as notes for the conductor to offer).
    const walk = await walkFranchise(best);
    const rootGroup = walk.continuityGroups[0];
    seasons.push(
      ...(rootGroup?.ids ?? [best.id])
        .map((id) => walk.fetched.get(id))
        .filter((m): m is AniListMedia => !!m),
    );
    media = mergeSeasons(seasons.length > 0 ? seasons : [best]);
    for (const group of walk.continuityGroups.slice(1)) {
      notes.push(
        `distinct continuity in franchise: ${group.displayTitle} (${group.ids.length} season${group.ids.length > 1 ? "s" : ""})`,
      );
    }
    if (walk.siblings.length > 0) {
      notes.push(`franchise siblings: ${walk.siblings.map((s) => s.title).join(", ")}`);
    }
  } else if (webIdentity) {
    // No AniList row means no relation graph: there is nothing to walk, and
    // the season list stays empty on purpose (recency falls to the identity's
    // own start year below).
    const synthetic = mediaFromWebIdentity(webIdentity);
    // The player's own words become an alternate title (M3R3 C2): the alias
    // probe above keys on what they TYPED, and the LLM-derived official title
    // is too unstable to be the only key. Skipped when a known title already
    // matches loosely — the probe would hit on that one anyway.
    const known = [synthetic.title.english, synthetic.title.romaji, ...synthetic.synonyms];
    if (!known.some((t) => !!t && titleKey(t) === titleKey(rawTitle))) {
      synthetic.synonyms.push(rawTitle);
    }
    media = synthetic;
    title = webIdentity.official_title || rawTitle;
    notes.push(
      `no AniList entry for "${rawTitle}" — identity and profile are grounded in live web search (existence verified by citation, §8)`,
    );
  } else {
    const searchVerdict = options.anilistId
      ? ""
      : rescue
        ? " and live web search found no real work behind it"
        : " and live web search was unavailable";
    throw new Error(
      `AniList has no match for "${rawTitle}"${searchVerdict} — existence unverified, research refused (§8)`,
    );
  }

  // Recency reads the NEWEST season in the merged run: mergeSeasons clones
  // the ROOT's startDate, and the root is usually the old season — a 2026
  // sequel folded into a 2019 root must still read post-cutoff (L7).
  const startYears = seasons
    .map((s) => s.startDate?.year)
    .filter((y): y is number => typeof y === "number");
  const newestStartYear =
    startYears.length > 0 ? Math.max(...startYears) : (media.startDate?.year ?? null);

  if (options.reuseExisting) {
    const slug = profileSlug(title);
    const [existing] = await db.select().from(profiles).where(eq(profiles.id, slug));
    // The walked TAGS are the mechanics gate's only live signal for a cached
    // row — stored genres are AniList's closed vocabulary and carry no
    // mechanics fragment. They are in scope here, so they are passed.
    if (existing) {
      return cachedReport(
        existing,
        newestStartYear,
        notes,
        relevantTags(media).map((t) => t.name),
      );
    }
  }

  // Embedding preflight — after the reuse early-return (the cached path
  // embeds nothing and must stay key-free), before everything paid. A missing
  // Voyage key fails here at $0, not after the synthesis run (2026-07-10:
  // a full pipeline died at the final corpus embed on exactly this).
  if (!options.skipCorpus) getVoyage();

  // 3. Wiki + scope — alternate titles feed discovery (kimetsu-no-yaiba).
  const alternates = [media.title.romaji, media.title.native, ...media.synonyms].filter(
    (t): t is string => !!t && t !== title,
  );
  const wiki = await findWiki(title, alternates);
  const scope = classifyScope(wiki?.articles ?? 0);
  const pages: WikiPage[] = [];
  if (wiki) {
    const categories = await listCategories(wiki.base);
    const plan = await planScrape(title, categories);
    if (plan.ip_notes) notes.push(`wiki: ${plan.ip_notes}`);
    const budget = PAGE_BUDGET[scope];
    const planned = [...plan.categories].sort((a, b) => a.priority - b.priority);
    // Dedupe across categories AND redirects (parse.title is post-redirect).
    const fetchedTitles = new Set<string>();
    for (const entry of planned) {
      if (pages.length >= budget) break;
      const remaining = budget - pages.length;
      const perType = Math.max(3, Math.floor(remaining / 4));
      const members = await categoryMembers(wiki.base, entry.wiki_category, perType);
      for (const member of members) {
        if (pages.length >= budget) break;
        if (fetchedTitles.has(member)) continue;
        const page = await fetchPage(wiki.base, member, entry.canonical_type);
        if (!page) continue;
        if (fetchedTitles.has(page.title)) continue;
        fetchedTitles.add(member);
        fetchedTitles.add(page.title);
        pages.push(page);
      }
    }
  } else {
    notes.push("no relevant wiki found — profile is AniList-only (thin canon layer)");
  }

  // LEVEL C (M3R3 C2) — the topic supplement, BEFORE synthesis so the search
  // harvest feeds the same organs the scrape would have. Two shapes: a full
  // sweep when the scrape produced nothing at all, and v3's thin-scrape
  // supplement (anime_research.py:1266-1294) when it produced too little —
  // only the organs the wiki starved buy a search.
  const scrapedChars = pages.reduce((n, p) => n + p.text.length, 0);
  const fullSweep = !wiki || pages.length === 0;
  const thinScrape =
    pages.length > 0 && (pages.length < THIN_SCRAPE_PAGES || scrapedChars < RICH_CONTENT_CHARS);
  const topicUrls: Record<string, string[]> = {};
  const searchedUrls: string[] = (rescue?.searchedUrls ?? []).map((u) => u.url);
  if (fullSweep || thinScrape) {
    const byTypeCounts = Object.fromEntries(CANONICAL_PAGE_TYPES.map((t) => [t, 0])) as Record<
      CanonicalPageType,
      number
    >;
    for (const page of pages) byTypeCounts[page.pageType] += 1;
    const topics = fullSweep ? SEARCH_TOPICS : missingTopics(byTypeCounts);
    if (topics.length > 0) {
      try {
        const searched = await searchTopics(title, topics);
        pages.push(...searched.pages);
        Object.assign(topicUrls, searched.topicUrls);
        searchedUrls.push(...searched.searchedUrls.map((u) => u.url));
        notes.push(
          `web search ${fullSweep ? "swept" : "supplemented"} ${topics.length} topic${topics.length > 1 ? "s" : ""} → ${searched.pages.length} page${searched.pages.length === 1 ? "" : "s"} (${searched.searchCount} searches)`,
        );
      } catch (err) {
        // The terminal-recall path must stay reachable when the whole chain
        // is dark — v3's orphaned fallback is the lesson this catch pays.
        console.warn("[research] topic search failed — continuing on scraped/recall coverage", {
          error: err instanceof Error ? err.message : String(err),
        });
        notes.push("web search unavailable — proceeding on scraped/recall coverage only");
      }
    }
  }

  // 4–7. Synthesis in v3's order.
  const byType = (t: WikiPage["pageType"]) => pages.filter((p) => p.pageType === t);
  /**
   * A search page's TITLE is a fabricated label ("<Title> — world (web
   * research)"), never a canon noun or a speaker name — its prose is content,
   * its title is not. Anywhere the pipeline reads `p.title` as content, only
   * wiki pages qualify (M3R3 C2 findings [6]/[9]).
   */
  const wikiOnly = (feed: WikiPage[]) => feed.filter((p) => (p.origin ?? "wiki") === "wiki");
  // L3, closed: the tonal read gets the HARVEST, not just the synopsis — and
  // the snapshot is what the provenance label is derived from below, so a
  // future page appended after this line cannot silently inflate that label.
  const tonalPages = [...pages];
  const interpretation = await interpretTonal(media, tonalPages);

  const techniquePages = byType("techniques");
  const powerSystem =
    techniquePages.length > 0 ? await synthesizePowerSystem(techniquePages) : undefined;

  const mainCast = media.characters.edges
    .filter((e) => e.role === "MAIN")
    .map((e) => e.node.name.full);
  const quotesByCharacter: Record<string, string[]> = {};
  /** The pages that fed the quote block — the mechanical voice check reads
   *  their FULL text below, not an excerpt of it. */
  const quoteSourcePages: WikiPage[] = [];
  // The key IS the speaker, and only a wiki character page is one-page-one-
  // character. A search "characters" page carries the whole cast under a
  // single synthetic title, so extracting from it would lump every voice
  // under one pseudo-name and mint a voice card literally called
  // "<Title> — characters (web research)". Excluded from the SPEAKER KEYING
  // only: since M3R4 B3 that page's prose also feeds the card synthesis, as
  // unattributed corpus (voiceCorpusPages below), on top of staying retrievable
  // at play. It reaches the voice organ; it is simply never credited as a
  // speaker, so a Level B profile builds cards from it without faking one.
  for (const page of wikiOnly(byType("characters"))) {
    const quotes = extractQuotes(page.text);
    if (quotes.length > 0) {
      quotesByCharacter[page.title] = quotes;
      quoteSourcePages.push(page);
    }
  }
  /**
   * The starvation repair (M2R4/M2R5 carry, M3R4 B3): the searched characters
   * page is excluded from the speaker-keyed block above for good reason, and
   * that exclusion was ALSO starving the card synthesis — a Level-B profile
   * (synthetic identity, `characters: { edges: [] }`, no wiki) hit
   * `quotes = {} && gapFill = []` and shipped ZERO voice cards in silence,
   * with the harvest M3R3 added for exactly this material sitting unread in
   * the corpus. It goes in as unattributed prose, never as a speaker.
   */
  const voiceCorpusPages = byType("characters").filter((p) => (p.origin ?? "wiki") !== "wiki");
  const gapFill = mainCast.filter((n) => !quotesByCharacter[n]);
  const voiceCards =
    Object.keys(quotesByCharacter).length > 0 || gapFill.length > 0 || voiceCorpusPages.length > 0
      ? await synthesizeVoiceCards(quotesByCharacter, gapFill, voiceCorpusPages)
      : [];

  // Lore/items pages are the stat organ whatever fetched them — a searched
  // stats topic feeds this exactly as a scraped lore category does
  // (synthesizeStatMapping returns the default, unbilled, on an empty feed).
  const lorePages = [...byType("lore"), ...byType("items")];
  // `let`: an ungrounded mapping is REPLACED by the default below, so the
  // persisted profile agrees with its own trust record (M3R3 C3 audit).
  let statMapping =
    wiki || lorePages.length > 0
      ? await synthesizeStatMapping(title, lorePages)
      : DEFAULT_STAT_MAPPING;

  const narrative = await synthesizeNarrative(title, {
    genres: media.genres,
    tags: relevantTags(media).map((t) => t.name),
    tropes: Object.entries(interpretation.storytelling_tropes)
      .filter(([, v]) => v)
      .map(([k]) => k),
    voiceCardNames: voiceCards.map((c) => c.name),
    // The assembled-profile payload v3's LAST position exists for.
    treatment: interpretation.treatment,
    combatStyle: interpretation.combat_style,
    powerSystemSummary: powerSystem
      ? `${powerSystem.name}: ${powerSystem.mechanics.slice(0, 300)}`
      : undefined,
    synopsis: media.description ?? undefined,
  });

  // 7b. THE GROUNDING PASS (M3R3 C3). Every synthesis call above was asked to
  // produce an answer, and a model asked for a power system writes one whether
  // the sources carry it or not — the founding profile's fluent recall at
  // confidence 90 is that failure in one row. So the desk's own claims are put
  // back to a reader of the pages that produced them, and what that evidence
  // does not carry loses its SOURCED label (never the content — C4 owns
  // player-facing surgery, and the stat mapping's demotion below is a
  // consistency repair, not surgery). A claim only exists when its own feed
  // does, so a page-less run buys no call at all rather than running blind.
  const groundingGaps: string[] = [];
  const claims: GroundingClaim[] = [];
  if (powerSystem) {
    claims.push({
      key: "power_system",
      claim: `The work's power system is "${powerSystem.name}": ${powerSystem.mechanics.slice(0, 200)}`,
      // Exactly the technique-page text synthesizePowerSystem consumed.
      evidence: claimEvidence(techniquePages, SYNTHESIS_FEEDS.power_system),
    });
  }
  if (statMapping.has_canonical_stats) {
    claims.push({
      key: "stat_mapping",
      claim: `The work shows a CANONICAL on-screen stat system ("${statMapping.system_name ?? "unnamed"}") — status windows, numeric ranks or explicit levels the audience sees.`,
      // Exactly the lore/items text synthesizeStatMapping consumed.
      evidence: claimEvidence(lorePages, SYNTHESIS_FEEDS.stat_mapping),
    });
  }
  // NO TONAL CLAIM, and no voice claim — the model auditor judges FACTUAL
  // claims only (M3R3 C3 audit).
  //
  // Tonal: an auditor that cannot falsify must not vote — the blueprint's
  // measured-not-vibed axiom. A 0-10 interpretive score is not a source-
  // checkable fact (the sources carry no scale, no polarity, no anchor), and
  // one all-or-nothing verdict over three axes controlled the provenance label
  // of all six Group A fields. The interpretation's grounding is STRUCTURAL
  // instead: interpretTonal READ the pages, and `tonalSource` below is a label
  // of what was read, never a second model's opinion of a score. This narrows
  // the ratified plan's "grounding pass ties claims to sources" to factual
  // claims — a deliberate narrowing, surfaced at commit.
  //
  // Voice: the check is mechanical below, because no judgment call exists —
  // the phrase came out of a fetched page or it did not.
  const unsupported = new Set<string>();
  // The initial state is the honest reading of a run with nothing auditable:
  // a work with no technique pages and no canonical stats offers the auditor
  // no source-checkable claim, and that is the ORDINARY shape of most anime,
  // not a hole. Only the branch below can move it.
  let grounding: ResearchTrust["grounding"] = "no_claims";
  if (claims.length > 0) {
    try {
      const { verdicts } = await groundProfile(title, claims);
      // ANY FALSE WINS on a duplicated key. Map-last-wins was fail-OPEN
      // through duplicates: GroundingVerdicts is an unconstrained array, so the
      // grammar cannot forbid two entries for one claim, and "return exactly
      // one verdict per claim" is prose. An auditor that said unsupported once
      // is never talked out of it by a second entry.
      const answered = new Map<string, boolean>();
      for (const v of verdicts) {
        const prev = answered.get(v.key);
        answered.set(v.key, prev === undefined ? v.supported : prev && v.supported);
      }
      // FAIL CLOSED. The auditor's when-in-doubt-unsupported rule must hold in
      // CODE, not just in its prompt: reading only the verdicts that came back
      // meant a dropped or re-keyed answer kept the sourced label — fail-OPEN,
      // the one place the pass's own doctrine inverted. Reconciliation walks
      // what was ASKED.
      for (const claim of claims) {
        const verdict = answered.get(claim.key);
        if (verdict === undefined) {
          unsupported.add(claim.key);
          groundingGaps.push(
            `grounding: no verdict returned for ${claim.key} — treated as unsupported`,
          );
        } else if (!verdict) {
          unsupported.add(claim.key);
        }
      }
      grounding = "audited";
    } catch (err) {
      // The chain must not die on its own auditor: an unavailable grounding
      // pass leaves the synthesis labels standing and says so — in the
      // PLAYER-facing channel too, because an unaudited profile must never be
      // indistinguishable from an audited-clean one.
      console.warn("[research] grounding pass failed — labels ride synthesis provenance", {
        error: err instanceof Error ? err.message : String(err),
      });
      grounding = "unavailable";
      notes.push("grounding pass unavailable — labels ride synthesis provenance");
      if (pages.length > 0) {
        groundingGaps.push(
          "grounding pass unavailable — provenance labels ride synthesis structure, unaudited",
        );
      }
    }
  }
  if (unsupported.has("power_system")) {
    groundingGaps.push(
      "grounding: the power system as synthesized is not supported by the fetched sources — treated as recall",
    );
  }
  if (unsupported.has("stat_mapping")) {
    groundingGaps.push(
      "grounding: the canonical stat mapping is not supported by the fetched sources — the profile carries no sourced stat system",
    );
  }
  // MECHANICAL VOICE GROUNDING. A signature phrase either appears in the pages
  // that fed the voice call or it does not — deterministic, free, and not a
  // question a model should be asked. The phrase is RE-EMITTED by
  // synthesizeVoiceCards, not copied from extractQuotes' output, so it passes
  // when the model echoes the quote faithfully MODULO PUNCTUATION; what fails
  // is model-invented or paraphrased voice matter. Skipped when no page fed
  // the quote block at all: with nothing to check against, every phrase would
  // fail by construction, and deriveTrust's "no character quotes" gap already
  // says the true thing about that run.
  //
  // Folding every non-alphanumeric run to one space absorbs the typographic
  // rewrites a model routinely makes when echoing a quote — curly quotes, "…"
  // for "...", em/en dashes for hyphens, a dropped comma. ("&" for "and"
  // stays unfixed: a word-level substitution, and rare.) Unicode-aware so a
  // non-Latin phrase folds to itself rather than to nothing.
  const normalizeVoice = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  if (quoteSourcePages.length > 0) {
    const haystacks = quoteSourcePages.map((p) => normalizeVoice(p.text));
    let ungroundedPhrases = 0;
    const ungroundedCards = new Set<string>();
    for (const card of voiceCards) {
      for (const phrase of card.signature_phrases) {
        const needle = normalizeVoice(phrase);
        if (!needle) continue;
        if (!haystacks.some((h) => h.includes(needle))) {
          ungroundedPhrases += 1;
          ungroundedCards.add(card.name);
        }
      }
    }
    if (ungroundedPhrases > 0) {
      groundingGaps.push(
        `grounding: ${ungroundedPhrases} signature phrase(s) across ${ungroundedCards.size} voice card(s) do not appear in the source pages — model-invented voice matter`,
      );
    }
  }
  // The demoted values, from here down. `powerSystemPresent` deliberately
  // survives: the system is still IN the profile and the KA will still use it;
  // what died is the claim that a source backed it.
  const powerSystemGrounded = !!powerSystem && !unsupported.has("power_system");
  // The stat mapping is the opposite case, and it must be demoted in the
  // CONTENT, not only in the record: §5's compiler spreads ip_mechanics
  // straight into the premise contract, and layout keys the diegetic status
  // window on `has_canonical_stats` — so persisting the kept ≥90 mapping under
  // a trust record that names no source would ship invented status windows as
  // canon. Falling back to the default makes the profile, the labels, the
  // coverage gate below and the KA's routing tell one story.
  if (unsupported.has("stat_mapping")) statMapping = DEFAULT_STAT_MAPPING;
  const statsCanonical = statMapping.has_canonical_stats;

  // 8. Derive the trust record (M3R3 C1) — computed from coverage, never
  // asserted. Field labels follow CONTENT, not wiki existence: a found-but-
  // unfetched wiki (the founding case's own shape) sources nothing.
  const quoteCharacters = Object.keys(quotesByCharacter).length;
  // Wiki-only, matching the CONTENT rule below: world_setting's page-fed
  // content is location/faction page titles, and a searched "world" page
  // contributes none of it — so it must not source the field's label or its
  // field_pages either. The search prose grounds the corpus, not this field.
  const settingPages = wikiOnly([...byType("locations"), ...byType("factions")]);
  const quotedCharacterPages = byType("characters").filter((p) => quotesByCharacter[p.title]);
  // What actually fed the voice organ: the speaker-keyed quote pages, plus the
  // unattributed cast corpus when that is what the cards had to read (M3R4 B3).
  // Empty ⇒ the cards are pure gap-fill recall, and the label says so.
  const voiceFeedPages = [...quotedCharacterPages, ...voiceCorpusPages];
  const contentChars = pages.reduce((n, p) => n + p.text.length, 0);
  // M3R3 C2: an organ's label follows the ORIGIN of the pages that fed it.
  // Wiki wins a mixed feed (the canon page is the stronger claim); a purely
  // searched organ says web_search out loud and never borrows wiki's credit.
  const organSource = (feed: WikiPage[]): OrganSource =>
    feed.some((p) => (p.origin ?? "wiki") === "wiki") ? "wiki" : feed.length > 0 ? "search" : null;
  const organPages = (feed: WikiPage[], topicKey: string): string[] => {
    const searched = organSource(feed) === "search" ? topicUrls[topicKey] : undefined;
    return searched && searched.length > 0 ? searched : feed.map((p) => p.url);
  };
  const fieldSources: Record<string, FieldSource> = {
    ...buildFieldSources({
      identityOrigin: media.id === 0 ? "web_search" : "anilist",
      // L3's label, now earned: the pages interpretTonal actually read. It is
      // a statement about WHAT WAS READ and nothing more — no model verdict
      // moves it, because no model was asked to grade an interpretive score.
      tonalSource: organSource(tonalPages),
      settingSource: organSource(settingPages),
      statMappingSource: statsCanonical ? organSource(lorePages) : null,
      powerSystemSource: powerSystemGrounded ? organSource(techniquePages) : null,
      voiceSource: voiceCards.length > 0 ? organSource(voiceFeedPages) : null,
    }),
    // An ungrounded power system is not absent — it is recall, and says so.
    // (An ungrounded stat mapping IS absent: it was replaced by the default
    // above, which no organ fed, so no provenance entry is its honest label —
    // exactly as the ≥90-bar's own discarded default carries none.)
    ...(powerSystem && !powerSystemGrounded ? { power_system: "model_recall" as const } : {}),
  };
  const fieldPages: Record<string, string[]> = {
    ...(powerSystemGrounded ? { power_system: organPages(techniquePages, "power_system") } : {}),
    ...(statsCanonical ? { stat_mapping: organPages(lorePages, "stats") } : {}),
    ...(settingPages.length > 0 ? { world_setting: organPages(settingPages, "world") } : {}),
    ...(voiceCards.length > 0 && voiceFeedPages.length > 0
      ? { voice_cards: organPages(voiceFeedPages, "characters") }
      : {}),
  };
  // The method ladder, widest grounding first: a synthetic identity is
  // web_search whatever else fired; search-fed pages make an AniList profile
  // the api_search hybrid; wiki pages alone are api_wiki; a wiki that yielded
  // nothing is the api_thin trap; bare AniList is the terminal recall floor.
  const wikiPageCount = pages.filter((p) => (p.origin ?? "wiki") === "wiki").length;
  const searchPageCount = pages.filter((p) => p.origin === "web_search").length;
  const method =
    media.id === 0
      ? "web_search"
      : searchPageCount > 0
        ? "api_search"
        : wikiPageCount > 0
          ? "api_wiki"
          : wiki
            ? "api_thin"
            : "anilist_only";
  // 8a. THE COVERAGE GATES (M3R3 C3, lesson L4). Read POST-grounding, and
  // post-DEMOTION: `statsCanonical` is now read off the demoted mapping, so a
  // mechanics IP whose stat system the sources never backed trips this gate on
  // the same value the profile actually ships.
  const impliesMechanics = mechanicsImplied(
    media.genres,
    relevantTags(media).map((t) => t.name),
  );
  const { defects } = coverageGates({
    mechanicsImplied: impliesMechanics,
    powerSystemPresent: !!powerSystem,
    statsCanonical,
    contentChars,
    pagesFetched: pages.length,
    // The voice organ (M3R4 B3): zero cards is a defect only when the run HAD
    // cast material to build them from. A genuinely cast-less source shipping
    // no cards is an honest absence, not a break.
    voiceCardCount: voiceCards.length,
    castMaterialPresent:
      mainCast.length > 0 ||
      Object.keys(quotesByCharacter).length > 0 ||
      voiceCorpusPages.length > 0,
  });
  const trust = deriveTrust({
    startYear: newestStartYear,
    pagesFetched: pages.length,
    contentChars,
    sourcesConsulted: [
      ...new Set([
        // A synthetic identity consulted no AniList row — saying otherwise
        // would put a source in the record that was never asked.
        ...(media.id !== 0 ? ["anilist"] : []),
        ...(wiki ? [wiki.base] : []),
        ...pages.map((p) => p.url),
        ...searchedUrls,
      ]),
    ],
    powerSystemPresent: !!powerSystem,
    powerSystemFromPages: powerSystemGrounded && techniquePages.length > 0,
    statsCanonical,
    statConfidence: statsCanonical ? statMapping.confidence : 0,
    voiceQuoteCharacters: quoteCharacters,
    mechanicsImplied: impliesMechanics,
    method,
    fieldSources,
    fieldPages,
    defects,
    groundingGaps,
    grounding,
  });
  for (const gap of trust.coverage_gaps) notes.push(`trust: ${gap}`);

  // 8b. Assemble + validate the typed Profile. A synthetic identity (Level B)
  // carries NO ids: id 0 is the marker, not a row, and persisting it as one
  // would let a later reader treat AniList as having verified this title.
  const anilistId = media.id === 0 ? null : media.id;
  const malId = media.id === 0 ? null : media.idMal;
  const profileId = profileSlug(title);
  const profile: z.infer<typeof Profile> = Profile.parse({
    id: profileId,
    title,
    alternate_titles: [media.title.romaji, media.title.native, ...media.synonyms].filter(
      (t): t is string => !!t && t !== title,
    ),
    anilist_id: anilistId ?? undefined,
    mal_id: malId ?? undefined,
    media_type: "anime",
    status:
      media.status === "FINISHED" || media.status === "CANCELLED"
        ? "completed"
        : media.status === "HIATUS"
          ? "hiatus"
          : "ongoing",
    ip_mechanics: {
      power_system: powerSystem,
      power_distribution: interpretation.power_distribution,
      stat_mapping: statMapping,
      combat_style: interpretation.combat_style,
      storytelling_tropes: interpretation.storytelling_tropes,
      world_setting: {
        genre: media.genres,
        // Canon nouns come from CANON pages only (M3R3 C2). §5's compiler
        // spreads ip_mechanics straight into the premise contract's World
        // component, so a search page's fabricated label was being SIGNED
        // into the campaign's spec-of-record as a place name.
        locations: wikiOnly(byType("locations"))
          .map((p) => p.title)
          .slice(0, 12),
        factions: wikiOnly(byType("factions"))
          .map((p) => p.title)
          .slice(0, 12),
      },
      voice_cards: voiceCards,
      author_voice: narrative.author_voice,
      visual_style: interpretation.visual_style,
    },
    canonical_dna: interpretation.treatment,
    canonical_composition: interpretation.framing,
    director_personality: narrative.director_personality,
    cast_depth_posture: narrative.cast_depth_posture,
    research_trust: trust,
  });

  // M3R3 C1: confidence is the DERIVED number — the 85+5+5 assertion died
  // with the founding defect (confidence 90, pagesFetched 0, "scrape is
  // not viable" in its own notes).
  const confidence = trust.derived_confidence;

  // 9. Persist corpus FIRST, then the profile: a crash mid-persist leaves
  // an old profile with fresh chunks (harmless) rather than a fresh profile
  // pointing at a half-replaced corpus (silent divergence).
  const { chunks } = options.skipCorpus ? { chunks: -1 } : await writeCorpus(db, profileId, pages);
  if (options.skipCorpus) notes.push("corpus SKIPPED (dev flag) — existing chunks untouched");

  await db
    .insert(profiles)
    .values({
      id: profileId,
      title,
      anilistId,
      malId,
      profile,
      scopeClass: scope,
      researchProvenance: {
        researchedAt: new Date().toISOString(),
        confidence,
        wikiBase: wiki?.base ?? null,
        seasonsMerged: seasons.length,
        pagesFetched: pages.length,
        // M3R3 C1: the full record rides provenance too — ops queries see
        // method + gaps, never a bare number with no way to ask why.
        trust,
        // v5 addition alongside narrative synthesis: cast depth posture.
        cast_depth_posture: narrative.cast_depth_posture,
        notes,
      },
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        title,
        anilistId,
        malId,
        profile,
        scopeClass: scope,
        researchProvenance: {
          researchedAt: new Date().toISOString(),
          confidence,
          wikiBase: wiki?.base ?? null,
          seasonsMerged: seasons.length,
          pagesFetched: pages.length,
          trust,
          cast_depth_posture: narrative.cast_depth_posture,
          notes,
        },
        updatedAt: new Date(),
      },
    });

  return {
    profileId,
    title,
    scope,
    seasonsMerged: seasons.length,
    trust,
    wikiBase: wiki?.base ?? null,
    pagesFetched: pages.length,
    chunksWritten: chunks,
    confidence,
    notes,
  };
}
