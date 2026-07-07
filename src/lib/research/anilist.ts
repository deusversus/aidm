/**
 * AniList client (blueprint §4.6; v3 scrapers/anilist.py carried).
 * Identity, community tags (the primary Treatment signal), and the
 * franchise graph with season-collapsing disambiguation. Public GraphQL,
 * no auth; 90 req/min — Retry-After honored, exponential backoff.
 */

const ENDPOINT = "https://graphql.anilist.co";
const MAX_RETRIES = 5;

// v3-carried field set — the profile's raw material.
const MEDIA_FIELDS = `
  id idMal title { romaji english native } synonyms format status
  episodes chapters description(asHtml: false) genres
  tags { name rank isMediaSpoiler }
  averageScore popularity
  characters(sort: FAVOURITES_DESC, perPage: 25) {
    edges { role node { name { full native } } }
  }
  relations { edges { relationType node { id title { romaji english } format status type } } }
  studios(isMain: true) { nodes { name } }
  startDate { year } season source countryOfOrigin isAdult
`;

const SEARCH_QUERY = `
query ($search: String) {
  Page(perPage: 5) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
  }
}`;

const FETCH_BY_ID_QUERY = `
query ($id: Int) { Media(id: $id) { ${MEDIA_FIELDS} } }`;

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  format: string | null;
  status: string | null;
  episodes: number | null;
  description: string | null;
  genres: string[];
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[];
  averageScore: number | null;
  popularity: number | null;
  characters: {
    edges: { role: string; node: { name: { full: string; native: string | null } } }[];
  };
  relations: {
    edges: {
      relationType: string;
      node: {
        id: number;
        title: { romaji: string | null; english: string | null };
        format: string | null;
        status: string | null;
        type: string;
      };
    }[];
  };
  studios: { nodes: { name: string }[] };
  startDate: { year: number | null } | null;
  season: string | null;
  source: string | null;
  isAdult: boolean;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if ([404, 500, 502, 503, 504].includes(res.status)) {
      lastError = new Error(`AniList ${res.status}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`AniList ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`AniList GraphQL: ${body.errors[0]?.message}`);
    if (!body.data) throw new Error("AniList: empty data");
    return body.data;
  }
  throw lastError ?? new Error("AniList: retries exhausted");
}

/** v3's disambiguation ladder: format priority, then popularity. */
const FORMAT_PRIORITY: Record<string, number> = {
  TV: 0,
  TV_SHORT: 1,
  MOVIE: 2,
  OVA: 3,
  ONA: 4,
  SPECIAL: 5,
};

export function pickBestMatch(candidates: AniListMedia[]): AniListMedia | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const fp = (FORMAT_PRIORITY[a.format ?? ""] ?? 9) - (FORMAT_PRIORITY[b.format ?? ""] ?? 9);
    if (fp !== 0) return fp;
    return (b.popularity ?? 0) - (a.popularity ?? 0);
  })[0] as AniListMedia;
}

export async function searchAnime(title: string): Promise<AniListMedia[]> {
  const data = await gql<{ Page: { media: AniListMedia[] } }>(SEARCH_QUERY, { search: title });
  return data.Page.media;
}

export async function fetchById(id: number): Promise<AniListMedia> {
  const data = await gql<{ Media: AniListMedia }>(FETCH_BY_ID_QUERY, { id });
  return data.Media;
}

/** Non-spoiler community tags at v3's relevance floor — the primary Treatment signal (§4.6). */
export function relevantTags(media: AniListMedia, minRank = 20): { name: string; rank: number }[] {
  return media.tags
    .filter((t) => !t.isMediaSpoiler && t.rank >= minRank)
    .map(({ name, rank }) => ({ name, rank }));
}

/**
 * Franchise BFS (v3-carried, incl. the SEASON_VARIANT_RE continuity
 * grouping the first cut dropped): SEQUEL/PREQUEL relations walk the
 * series; title normalization splits the walk into DISTINCT CONTINUITY
 * GROUPS (Naruto vs Shippuden vs Boruto) so the SZ conductor can present
 * a choice instead of silently merging universes. SPIN_OFF / SIDE_STORY /
 * ALTERNATIVE / PARENT are franchise siblings (series formats only, per
 * v3). Depth-capped; every fetched media is returned for reuse.
 */
const SAME_SERIES = new Set(["SEQUEL", "PREQUEL"]);
const FRANCHISE_KIN = new Set(["SPIN_OFF", "SIDE_STORY", "ALTERNATIVE", "PARENT"]);
const SERIES_FORMATS = new Set(["TV", "ONA", "TV_SHORT"]);
const MAX_DEPTH = 10;

/** v3's season-variant normalizer: "X Season 2", "X Part Two", "X 3rd Season: Sub" → "X". */
export const SEASON_VARIANT_RE =
  /\s*(?:Season\s+\d+|S\d+|\d+(?:st|nd|rd|th)\s+Season|Part\s+\d+|Cour\s+\d+|(?:Part|Season)\s+(?:One|Two|Three|Four|Five))(?:\s*[:：\-–—]\s*.+)?$/i;

export function continuityBase(title: string): string {
  return title.replace(SEASON_VARIANT_RE, "").trim().toLowerCase();
}

export interface ContinuityGroup {
  /** Normalized base title, e.g. "naruto" vs "naruto shippuden". */
  base: string;
  displayTitle: string;
  ids: number[];
}

export interface FranchiseWalk {
  /** Season-variant groups across the walked series, root's group first. */
  continuityGroups: ContinuityGroup[];
  /** Every media fetched during the walk, reusable by the caller. */
  fetched: Map<number, AniListMedia>;
  /** Distinct franchise siblings (spinoffs, side stories, alternates). */
  siblings: { id: number; title: string; relationType: string }[];
}

export async function walkFranchise(root: AniListMedia): Promise<FranchiseWalk> {
  const fetched = new Map<number, AniListMedia>([[root.id, root]]);
  const siblings = new Map<number, { id: number; title: string; relationType: string }>();
  const queue: { media: AniListMedia; depth: number }[] = [{ media: root, depth: 0 }];
  const seen = new Set<number>([root.id]);

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth >= MAX_DEPTH) continue;
    for (const edge of item.media.relations.edges) {
      const node = edge.node;
      if (node.type !== "ANIME" || seen.has(node.id)) continue;
      if (SAME_SERIES.has(edge.relationType) && SERIES_FORMATS.has(node.format ?? "")) {
        seen.add(node.id);
        const full = await fetchById(node.id);
        fetched.set(node.id, full);
        queue.push({ media: full, depth: item.depth + 1 });
      } else if (FRANCHISE_KIN.has(edge.relationType) && SERIES_FORMATS.has(node.format ?? "")) {
        seen.add(node.id);
        siblings.set(node.id, {
          id: node.id,
          title: node.title.english ?? node.title.romaji ?? String(node.id),
          relationType: edge.relationType,
        });
      }
    }
  }

  const groups = new Map<string, ContinuityGroup>();
  for (const media of fetched.values()) {
    const display = media.title.english ?? media.title.romaji ?? String(media.id);
    const base = continuityBase(display);
    const group = groups.get(base);
    if (group) {
      group.ids.push(media.id);
    } else {
      groups.set(base, { base, displayTitle: display, ids: [media.id] });
    }
  }
  const rootBase = continuityBase(root.title.english ?? root.title.romaji ?? String(root.id));
  const continuityGroups = [...groups.values()].sort((a, b) =>
    a.base === rootBase ? -1 : b.base === rootBase ? 1 : a.base.localeCompare(b.base),
  );
  return { continuityGroups, fetched, siblings: [...siblings.values()] };
}

/**
 * Merge a season chain into one series view (v3 fetch_full_series): tags
 * union at max rank, characters union by name, genres union, episodes
 * summed, status = earliest in the airing order.
 */
const STATUS_ORDER: Record<string, number> = {
  RELEASING: 0,
  NOT_YET_RELEASED: 1,
  HIATUS: 2,
  FINISHED: 3,
  CANCELLED: 4,
};

export function mergeSeasons(seasons: AniListMedia[]): AniListMedia {
  const [first, ...rest] = seasons;
  if (!first) throw new Error("mergeSeasons: empty");
  const merged: AniListMedia = structuredClone(first);
  for (const s of rest) {
    merged.episodes = (merged.episodes ?? 0) + (s.episodes ?? 0);
    merged.genres = [...new Set([...merged.genres, ...s.genres])];
    merged.synonyms = [...new Set([...merged.synonyms, ...s.synonyms])];
    const tagRank = new Map(merged.tags.map((t) => [t.name, t]));
    for (const t of s.tags) {
      const prev = tagRank.get(t.name);
      if (!prev || t.rank > prev.rank) tagRank.set(t.name, t);
    }
    merged.tags = [...tagRank.values()];
    const charNames = new Set(merged.characters.edges.map((e) => e.node.name.full));
    for (const e of s.characters.edges) {
      if (!charNames.has(e.node.name.full)) merged.characters.edges.push(e);
    }
    if ((STATUS_ORDER[s.status ?? ""] ?? 9) < (STATUS_ORDER[merged.status ?? ""] ?? 9)) {
      merged.status = s.status;
    }
  }
  return merged;
}
