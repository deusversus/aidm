import { type FieldSource, ResearchTrust } from "@/lib/types/profile";

/**
 * Derived research trust (M3R3 C1). The founding defect: a profile shipped
 * at confidence 90 with pagesFetched 0 and "scrape is not viable" in its own
 * notes — the number was asserted (85+5+5 arithmetic), never derived, and
 * its only reader was the cache echo. Confidence here is COMPUTED from
 * source coverage, v3's discipline (_assess_and_adjust_confidence, carried
 * as doctrine, re-derived for v5's shapes), and it travels: onto the
 * Profile, into the conductor's tool result, and to the player's ear.
 *
 * All weights are first-pass tunables (§5.1 doctrine); the SHAPE is the
 * contract — coverage in, honest number + named gaps out.
 */

/**
 * Recall-trust floor, deliberately conservative: any title whose newest
 * season starts in or after this year is treated as beyond reliable recall
 * for the ADAPTATION even when the source material is older — the user's
 * normal case (new seasons of little-known IP). Year-granular on purpose:
 * this is a floor policy, not a claim about any specific model's cutoff
 * date — the synthesis models' cutoffs vary and are not published per-tier.
 */
export const KNOWLEDGE_CUTOFF_YEAR = 2026;

/**
 * Below this many total characters of fetched text, a scrape is stubs —
 * page COUNT alone must not buy the rich-scrape credit (ten 60-char stubs
 * from a brand-new wiki are not ten articles).
 */
export const RICH_CONTENT_CHARS = 15_000;

/** AniList tag/genre fragments that imply a game-mechanics power system —
 *  a profile for one of these WITHOUT a power system is presumptively
 *  under-researched (the LitRPG-with-power_system-null defect). */
const MECHANICS_TAG_FRAGMENTS = [
  "litrpg",
  "rpg",
  "video game",
  "dungeon",
  "level system",
  "cultivation",
  "card battle",
  "battle royale",
];

export function mechanicsImplied(genres: string[], tagNames: string[]): boolean {
  const hay = [...genres, ...tagNames].map((s) => s.toLowerCase());
  return hay.some((s) => MECHANICS_TAG_FRAGMENTS.some((f) => s.includes(f)));
}

/**
 * What KIND of fetched page fed an organ — `null` means nothing did. The
 * api_thin trap this exists to close: wiki found, zero pages fetched, and
 * every label still reading "wiki_page" would repeat the founding defect one
 * field down (asserted provenance instead of asserted confidence). M3R3 C2
 * widens the same discipline to search-fed organs: a field the fallback
 * chain grounded reads "web_search", never "wiki_page" — the honest label is
 * the whole point, and a search page is not a canon wiki page.
 */
export type OrganSource = "wiki" | "search" | null;

/**
 * Inputs for the per-field provenance map — each keyed on whether CONTENT
 * actually flowed from pages, and from WHICH kind, never on a wiki merely
 * existing.
 */
export interface FieldSourceInputs {
  /**
   * Where the IDENTITY itself came from (M3R3 C2). A Level B profile's genre
   * list came from the web identity, not from an AniList row that was never
   * asked — labeling its ungrounded world_setting "anilist" would contradict
   * the same record's sources_consulted, which deliberately omits AniList
   * there. One record, one story about its own sources.
   */
  identityOrigin: "anilist" | "web_search";
  /** Location + faction pages — the only page-fed world_setting content. */
  settingSource: OrganSource;
  /** A stat mapping synthesized FROM lore/items pages AND kept (the ≥90 bar
   *  in synthesize.ts) — the discarded default came from NO organ. */
  statMappingSource: OrganSource;
  /** A power system synthesized from technique pages. */
  powerSystemSource: OrganSource;
  /** Pages behind characters with REAL extracted quotes. */
  voiceSource: OrganSource;
}

const LABEL = { wiki: "wiki_page", search: "web_search" } as const satisfies Record<
  Exclude<OrganSource, null>,
  FieldSource
>;

export function buildFieldSources(i: FieldSourceInputs): Record<string, FieldSource> {
  return {
    // The tonal interpretation reads AniList metadata only (C3 grounds it) —
    // labeled recall honestly, not aspirationally.
    canonical_dna: "model_recall",
    canonical_composition: "model_recall",
    storytelling_tropes: "model_recall",
    visual_style: "model_recall",
    director_personality: "model_recall",
    author_voice: "model_recall",
    cast_depth_posture: "model_recall",
    combat_style: "model_recall",
    power_distribution: "model_recall",
    // locations/factions are the only page-fed content — no setting pages, no
    // page label at all, and the fallback names whichever identity carried the
    // genre list that is then all world_setting holds.
    world_setting: i.settingSource
      ? LABEL[i.settingSource]
      : i.identityOrigin === "web_search"
        ? "web_search"
        : "anilist",
    ...(i.powerSystemSource ? { power_system: LABEL[i.powerSystemSource] } : {}),
    // Absence IS the label for an ungrounded stat mapping: the hardcoded
    // default was fed by no source, so it carries no provenance entry.
    ...(i.statMappingSource ? { stat_mapping: LABEL[i.statMappingSource] } : {}),
    voice_cards: i.voiceSource ? LABEL[i.voiceSource] : "model_recall",
  };
}

export interface TrustInputs {
  /** NEWEST season's start year across the merged run (recency signal). */
  startYear: number | null;
  pagesFetched: number;
  /** Total characters of fetched page text — the stub-wiki discriminator. */
  contentChars: number;
  /** URLs/APIs actually consulted (anilist, wiki base, every page url). */
  sourcesConsulted: string[];
  powerSystemPresent: boolean;
  /** True only when the power system was synthesized FROM fetched pages. */
  powerSystemFromPages: boolean;
  statsCanonical: boolean;
  statConfidence: number;
  /** Characters with REAL extracted quotes behind their voice cards. */
  voiceQuoteCharacters: number;
  mechanicsImplied: boolean;
  method: ResearchTrust["method"];
  fieldSources: Record<string, FieldSource>;
  fieldPages: Record<string, string[]>;
}

export function deriveTrust(inputs: TrustInputs): ResearchTrust {
  const gaps: string[] = [];
  let score = 20; // floor: an identity alone is a rumor, not a profile
  // Identity verification, method-aware (M3R3 C2). researchTitle throws when
  // NEITHER an AniList row nor live citation verifies the work, so this term is
  // always earned — but Level B's identity is verified BY CITATION, which is
  // real verification and weaker than an API row. It must not borrow AniList's
  // credit on a title AniList was never able to answer for.
  score += inputs.method === "web_search" ? 10 : 15;

  const richScrape = inputs.pagesFetched >= 10 && inputs.contentChars >= RICH_CONTENT_CHARS;
  if (richScrape) score += 30;
  else if (inputs.pagesFetched > 0) {
    score += 15;
    if (inputs.pagesFetched >= 10) {
      gaps.push(
        `${inputs.pagesFetched} pages fetched but only ${inputs.contentChars} characters of text — the wiki is mostly stubs, coverage is shallow`,
      );
    }
  } else {
    gaps.push(
      "zero source pages fetched — every synthesized field is model recall over AniList metadata",
    );
  }

  if (inputs.powerSystemFromPages) score += 10;
  else if (inputs.powerSystemPresent) score += 5;

  if (inputs.statsCanonical || inputs.statConfidence >= 50) score += 5;

  if (inputs.voiceQuoteCharacters > 0) score += 10;
  else gaps.push("no character quotes extracted — voice cards are recall or generic");

  if (inputs.mechanicsImplied && !inputs.powerSystemPresent) {
    score -= 15;
    gaps.push(
      "genre/tags imply a game-mechanics power system; none was extracted — the KA would run without §4 constraints",
    );
  }

  const postCutoff = inputs.startYear !== null && inputs.startYear >= KNOWLEDGE_CUTOFF_YEAR;
  if (postCutoff && inputs.pagesFetched === 0) {
    score -= 20;
    gaps.push(
      `title starts ${inputs.startYear} — past the knowledge cutoff — with zero fetched sources: recall cannot know this adaptation`,
    );
  } else if (postCutoff && !richScrape) {
    score -= 10;
    gaps.push(
      `title starts ${inputs.startYear} — past the knowledge cutoff — and fetched sources are thin: recall cannot fill what the pages don't carry`,
    );
  }

  return ResearchTrust.parse({
    method: inputs.method,
    derived_confidence: Math.min(95, Math.max(5, score)),
    sources_consulted: inputs.sourcesConsulted,
    pages_fetched: inputs.pagesFetched,
    post_cutoff: postCutoff,
    ...(inputs.startYear !== null ? { start_year: inputs.startYear } : {}),
    field_sources: inputs.fieldSources,
    field_pages: inputs.fieldPages,
    coverage_gaps: gaps,
  });
}
