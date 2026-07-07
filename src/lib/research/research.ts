/**
 * The research pipeline orchestrator (blueprint §4.6, §8; v3's API-first
 * pipeline carried). Existence-validation is the SZ conductor's guard: a
 * title that doesn't resolve on AniList throws — the engine never confirms
 * a season it cannot verify.
 */

import type { Db } from "@/lib/db";
import { profiles } from "@/lib/db/schema";
import { Profile } from "@/lib/types/profile";
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
  interpretTonal,
  synthesizeNarrative,
  synthesizePowerSystem,
  synthesizeStatMapping,
  synthesizeVoiceCards,
} from "./synthesize";
import {
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

export function profileSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
}

export interface ResearchOptions {
  /** Dev iteration: skip corpus re-embedding (profile/synthesis only). */
  skipCorpus?: boolean;
  /**
   * Pin the AniList entry (the SZ conductor's disambiguation seam, §8):
   * when set, search is skipped and this id is researched directly.
   */
  anilistId?: number;
}

export async function researchTitle(
  db: Db,
  rawTitle: string,
  options: ResearchOptions = {},
): Promise<ResearchReport> {
  const notes: string[] = [];

  // 1. Identity + existence validation (§8 guard) — or a pinned entry.
  const best = options.anilistId
    ? await fetchById(options.anilistId)
    : pickBestMatch(await searchAnime(rawTitle));
  if (!best) {
    throw new Error(
      `AniList has no match for "${rawTitle}" — existence unverified, research refused (§8)`,
    );
  }
  const title = best.title.english ?? best.title.romaji ?? rawTitle;

  // 2. Franchise walk → merge ONLY the root's continuity group (v3's
  //    SEASON_VARIANT_RE discipline: Shippuden is not Naruto; the other
  //    groups surface as notes for the conductor to offer).
  const walk = await walkFranchise(best);
  const rootGroup = walk.continuityGroups[0];
  const seasons: AniListMedia[] = (rootGroup?.ids ?? [best.id])
    .map((id) => walk.fetched.get(id))
    .filter((m): m is AniListMedia => !!m);
  const media = mergeSeasons(seasons.length > 0 ? seasons : [best]);
  for (const group of walk.continuityGroups.slice(1)) {
    notes.push(
      `distinct continuity in franchise: ${group.displayTitle} (${group.ids.length} season${group.ids.length > 1 ? "s" : ""})`,
    );
  }
  if (walk.siblings.length > 0) {
    notes.push(`franchise siblings: ${walk.siblings.map((s) => s.title).join(", ")}`);
  }

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

  // 4–7. Synthesis in v3's order.
  const byType = (t: WikiPage["pageType"]) => pages.filter((p) => p.pageType === t);
  const interpretation = await interpretTonal(media);

  const techniquePages = byType("techniques");
  const powerSystem =
    techniquePages.length > 0 ? await synthesizePowerSystem(techniquePages) : undefined;

  const mainCast = media.characters.edges
    .filter((e) => e.role === "MAIN")
    .map((e) => e.node.name.full);
  const quotesByCharacter: Record<string, string[]> = {};
  for (const page of byType("characters")) {
    const quotes = extractQuotes(page.text);
    if (quotes.length > 0) quotesByCharacter[page.title] = quotes;
  }
  const gapFill = mainCast.filter((n) => !quotesByCharacter[n]);
  const voiceCards =
    Object.keys(quotesByCharacter).length > 0 || gapFill.length > 0
      ? await synthesizeVoiceCards(quotesByCharacter, gapFill)
      : [];

  const statMapping = wiki
    ? await synthesizeStatMapping(title, [...byType("lore"), ...byType("items")])
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

  // 8. Assemble + validate the typed Profile.
  const profileId = profileSlug(title);
  const profile: z.infer<typeof Profile> = Profile.parse({
    id: profileId,
    title,
    alternate_titles: [media.title.romaji, media.title.native, ...media.synonyms].filter(
      (t): t is string => !!t && t !== title,
    ),
    anilist_id: media.id,
    mal_id: media.idMal ?? undefined,
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
        locations: byType("locations")
          .map((p) => p.title)
          .slice(0, 12),
        factions: byType("factions")
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
  });

  // v3's confidence math: base 85, +5 AniList, +5 wiki — the wiki bonus
  // requires actual pages, not just a found wiki (audit fix).
  const confidence = 85 + 5 + (wiki && pages.length > 0 ? 5 : 0);

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
      anilistId: media.id,
      malId: media.idMal,
      profile,
      scopeClass: scope,
      researchProvenance: {
        researchedAt: new Date().toISOString(),
        confidence,
        wikiBase: wiki?.base ?? null,
        seasonsMerged: seasons.length,
        pagesFetched: pages.length,
        // v5 addition alongside narrative synthesis: cast depth posture.
        cast_depth_posture: narrative.cast_depth_posture,
        notes,
      },
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        title,
        anilistId: media.id,
        malId: media.idMal,
        profile,
        scopeClass: scope,
        researchProvenance: {
          researchedAt: new Date().toISOString(),
          confidence,
          wikiBase: wiki?.base ?? null,
          seasonsMerged: seasons.length,
          pagesFetched: pages.length,
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
    wikiBase: wiki?.base ?? null,
    pagesFetched: pages.length,
    chunksWritten: chunks,
    confidence,
    notes,
  };
}
