"""
AniList GraphQL Client for AIDM v3.

Fetches structured anime/manga metadata from AniList's public GraphQL API:
- Titles (romaji, english, native) → profile.name, profile.aliases
- Genres → profile.detected_genres
- Ranked tags → input for DNA scale derivation
- Characters (name, role) → voice_cards keys
- Description → raw_content supplement
- Relations → disambiguation / series_group
- Status → drives cache TTL (FINISHED vs RELEASING)

AniList API docs: https://anilist.gitbook.io/anilist-apiv2-docs/
Rate limit: 90 requests per minute (no auth required).
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

import requests

logger = logging.getLogger(__name__)


# ─── GraphQL Queries ─────────────────────────────────────────────────────────

# Multi-result search: returns up to 5 candidates for disambiguation
SEARCH_QUERY = """
query ($search: String) {
  Page(page: 1, perPage: 5) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      title {
        romaji
        english
        native
      }
      synonyms
      format
      status
      episodes
      chapters
      description(asHtml: false)
      genres
      tags {
        name
        rank
        isMediaSpoiler
      }
      averageScore
      meanScore
      popularity
      trending
      characters(sort: FAVOURITES_DESC, page: 1, perPage: 25) {
        nodes {
          name {
            full
            native
          }
        }
        edges {
          role
          node {
            name {
              full
              native
            }
          }
          voiceActors(language: JAPANESE) {
            name {
              full
            }
          }
        }
      }
      relations {
        edges {
          relationType
          node {
            id
            title {
              romaji
              english
            }
            format
            status
            type
          }
        }
      }
      studios(isMain: true) {
        nodes {
          name
        }
      }
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      season
      seasonYear
      source
      countryOfOrigin
      isAdult
    }
  }
}
"""

# Search with explicit type parameter for manga/manhwa fallback
SEARCH_QUERY_TYPED = """
query ($search: String, $type: MediaType) {
  Media(search: $search, type: $type) {
    id
    title {
      romaji
      english
      native
    }
    synonyms
    format
    status
    episodes
    chapters
    description(asHtml: false)
    genres
    tags {
      name
      rank
      isMediaSpoiler
    }
    averageScore
    meanScore
    popularity
    trending
    characters(sort: FAVOURITES_DESC, page: 1, perPage: 25) {
      nodes {
        name {
          full
          native
        }
      }
      edges {
        role
        node {
          name {
            full
            native
          }
        }
        voiceActors(language: JAPANESE) {
          name {
            full
          }
        }
      }
    }
    relations {
      edges {
        relationType
        node {
          id
          title {
            romaji
            english
          }
          format
          status
          type
        }
      }
    }
    studios(isMain: true) {
      nodes {
        name
      }
    }
    startDate {
      year
      month
      day
    }
    endDate {
      year
      month
      day
    }
    season
    seasonYear
    source
    countryOfOrigin
    isAdult
  }
}
"""


# Fetch a single media entry by AniList ID (for season merging)
FETCH_BY_ID_QUERY = """
query ($id: Int) {
  Media(id: $id) {
    id
    title {
      romaji
      english
      native
    }
    synonyms
    format
    status
    episodes
    chapters
    description(asHtml: false)
    genres
    tags {
      name
      rank
      isMediaSpoiler
    }
    averageScore
    popularity
    characters(sort: FAVOURITES_DESC, page: 1, perPage: 25) {
      edges {
        role
        node {
          name {
            full
            native
          }
        }
        voiceActors(language: JAPANESE) {
          name {
            full
          }
        }
      }
    }
    relations {
      edges {
        relationType
        node {
          id
          title {
            romaji
            english
          }
          format
          status
          type
        }
      }
    }
    startDate {
      year
      month
      day
    }
    source
    countryOfOrigin
    isAdult
  }
}
"""


# ─── Data Classes ────────────────────────────────────────────────────────────

@dataclass
class AniListCharacter:
    """A character from AniList."""
    name: str
    native_name: Optional[str] = None
    role: str = "SUPPORTING"  # MAIN, SUPPORTING, BACKGROUND
    voice_actor: Optional[str] = None


@dataclass
class AniListRelation:
    """A related media entry from AniList."""
    id: int
    title_romaji: str
    title_english: Optional[str] = None
    format: Optional[str] = None  # TV, MOVIE, OVA, SPECIAL, ONA, MANGA, etc.
    status: Optional[str] = None
    media_type: Optional[str] = None  # ANIME, MANGA
    relation_type: str = "SEQUEL"  # SEQUEL, PREQUEL, SIDE_STORY, PARENT, etc.


@dataclass
class AniListTag:
    """A ranked tag from AniList (community-voted relevance)."""
    name: str
    rank: int  # 0-100, how strongly this tag applies
    is_spoiler: bool = False


@dataclass
class AniListResult:
    """Complete structured result from AniList API."""
    
    # Identity
    id: int = 0
    title_romaji: str = ""
    title_english: Optional[str] = None
    title_native: Optional[str] = None
    synonyms: list[str] = field(default_factory=list)
    
    # Metadata
    format: Optional[str] = None  # TV, MOVIE, OVA, MANGA, etc.
    status: str = "FINISHED"  # FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS
    episodes: Optional[int] = None
    chapters: Optional[int] = None
    description: Optional[str] = None
    country_of_origin: Optional[str] = None
    source: Optional[str] = None  # MANGA, LIGHT_NOVEL, ORIGINAL, etc.
    is_adult: bool = False
    
    # Dates
    start_year: Optional[int] = None
    season: Optional[str] = None
    
    # Scores
    average_score: Optional[int] = None
    popularity: Optional[int] = None
    
    # Genres & Tags (critical for DNA derivation)
    genres: list[str] = field(default_factory=list)
    tags: list[AniListTag] = field(default_factory=list)
    
    # Characters (sorted by favourites)
    characters: list[AniListCharacter] = field(default_factory=list)
    
    # Relations (for franchise/disambiguation)
    relations: list[AniListRelation] = field(default_factory=list)
    
    # Studio
    studio: Optional[str] = None
    
    def get_all_titles(self) -> list[str]:
        """Get all known titles for this media."""
        titles = []
        if self.title_romaji:
            titles.append(self.title_romaji)
        if self.title_english and self.title_english != self.title_romaji:
            titles.append(self.title_english)
        if self.title_native:
            titles.append(self.title_native)
        titles.extend(self.synonyms)
        return titles
    
    def get_non_spoiler_tags(self, min_rank: int = 0) -> list[AniListTag]:
        """Get tags filtered by minimum rank and excluding spoilers."""
        return [t for t in self.tags if not t.is_spoiler and t.rank >= min_rank]
    
    def get_main_characters(self) -> list[AniListCharacter]:
        """Get only MAIN role characters."""
        return [c for c in self.characters if c.role == "MAIN"]


# ─── Client ──────────────────────────────────────────────────────────────────

ANILIST_API_URL = "https://graphql.anilist.co"
MAX_RETRIES = 3
RATE_LIMIT_SLEEP = 2.0  # seconds to wait on rate limit


class AniListClient:
    """Async-compatible AniList GraphQL client."""
    
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
    
    def _execute_query(self, query: str, variables: dict) -> dict:
        """Execute a GraphQL query against AniList."""
        for attempt in range(MAX_RETRIES):
            try:
                response = self._session.post(
                    ANILIST_API_URL,
                    json={"query": query, "variables": variables},
                    timeout=15,
                )
                
                if response.status_code == 429:
                    # Rate limited — back off
                    retry_after = int(response.headers.get("Retry-After", RATE_LIMIT_SLEEP))
                    logger.warning(f"AniList rate limited, waiting {retry_after}s...")
                    import time
                    time.sleep(retry_after)
                    continue
                
                response.raise_for_status()
                data = response.json()
                
                if "errors" in data:
                    logger.warning(f"AniList GraphQL errors: {data['errors']}")
                    return {}
                
                return data.get("data", {})
                
            except requests.RequestException as e:
                logger.error(f"AniList request failed (attempt {attempt+1}): {e}")
                if attempt < MAX_RETRIES - 1:
                    import time
                    time.sleep(2 ** attempt)
        
        return {}
    
    # Format priority for disambiguation: users almost always mean the main series
    FORMAT_PRIORITY = {'TV': 0, 'TV_SHORT': 1, 'MOVIE': 2, 'OVA': 3, 'ONA': 4, 'SPECIAL': 5, 'MUSIC': 6}
    
    async def search(self, title: str, media_type: str = "ANIME") -> Optional[AniListResult]:
        """
        Search AniList for an anime/manga by title.
        
        Uses multi-result Page query and picks the best match using
        format-aware disambiguation (prefers TV over ONA/OVA/SPECIAL).
        
        Args:
            title: Search term (anime/manga name)
            media_type: "ANIME" or "MANGA"
            
        Returns:
            AniListResult or None if not found
        """
        loop = asyncio.get_event_loop()
        
        if media_type == "ANIME":
            data = await loop.run_in_executor(
                None, self._execute_query, SEARCH_QUERY, {"search": title}
            )
            # Page query returns results under Page.media
            media_list = data.get("Page", {}).get("media", [])
            if not media_list:
                logger.info(f"AniList: No results for '{title}' (type={media_type})")
                return None
            
            best = self._pick_best_match(media_list, title)
            return self._parse_media(best)
        else:
            data = await loop.run_in_executor(
                None, self._execute_query, SEARCH_QUERY_TYPED,
                {"search": title, "type": media_type}
            )
            media = data.get("Media")
            if not media:
                logger.info(f"AniList: No results for '{title}' (type={media_type})")
                return None
            return self._parse_media(media)
    
    def _pick_best_match(self, media_list: list, search_title: str) -> dict:
        """
        Pick the best match from multiple AniList results.
        
        Priority:
        1. Prefer TV format over ONA/OVA/SPECIAL (users mean the main series)
        2. Among same format, prefer higher popularity
        3. First result as tiebreaker (AniList's own relevance ranking)
        """
        if len(media_list) == 1:
            return media_list[0]
        
        # Log all candidates for debugging
        for m in media_list:
            title = m.get('title', {}).get('english') or m.get('title', {}).get('romaji', '?')
            fmt = m.get('format', '?')
            pop = m.get('popularity', 0)
            logger.info(f"AniList candidate: {title} ({fmt}, pop={pop})")
        
        def score(media):
            fmt = media.get('format', 'SPECIAL')
            format_score = self.FORMAT_PRIORITY.get(fmt, 5)
            # Invert popularity so higher = better (lower score)
            pop_score = -(media.get('popularity', 0) or 0)
            return (format_score, pop_score)
        
        best = min(media_list, key=score)
        chosen_title = best.get('title', {}).get('english') or best.get('title', {}).get('romaji', '?')
        chosen_fmt = best.get('format', '?')
        logger.info(f"Disambiguated: chose '{chosen_title}' ({chosen_fmt}) from {len(media_list)} candidates")
        return best
    
    async def search_with_fallback(self, title: str) -> Optional[AniListResult]:
        """
        Search AniList, trying ANIME first then MANGA if not found.
        """
        result = await self.search(title, "ANIME")
        if not result:
            logger.info(f"AniList: No anime result, falling back to MANGA search")
            result = await self.search(title, "MANGA")
        return result
    
    async def fetch_full_series(self, primary: AniListResult) -> AniListResult:
        """
        Walk the relations graph (BFS) to merge ALL seasons of the same series.
        
        Uses breadth-first traversal to follow SEQUEL/PREQUEL chains to any
        depth (e.g. S1→S2→S3→...→S7), not just direct relations.
        
        Merges into the primary result:
        - Tags: union (highest rank wins for duplicates)
        - Characters: union (deduplicated by name)
        - Genres: union
        - Episodes: sum
        - Status: latest season's status wins
        - Synonyms: union
        
        Returns:
            Enriched AniListResult with all seasons merged
        """
        MAX_DEPTH = 10  # Safety cap to prevent infinite traversal
        
        loop = asyncio.get_event_loop()
        visited: set[int] = {primary.id}
        queue: list[int] = []
        related_results: list[AniListResult] = []
        
        # Seed queue from primary's direct relations
        for rel in primary.relations:
            if rel.relation_type in ("SEQUEL", "PREQUEL") and rel.format == primary.format:
                if rel.id not in visited:
                    queue.append(rel.id)
                    visited.add(rel.id)
        
        if not queue:
            logger.info(f"No related seasons found for merging")
            return primary
        
        depth = 0
        logger.info(f"Walking relations graph (BFS) for season merging...")
        
        # BFS: fetch each season, then check ITS relations for more seasons
        while queue and depth < MAX_DEPTH:
            depth += 1
            current_batch = list(queue)
            queue.clear()
            
            for rel_id in current_batch:
                data = await loop.run_in_executor(
                    None, self._execute_query, FETCH_BY_ID_QUERY, {"id": rel_id}
                )
                media = data.get("Media")
                if not media:
                    continue
                
                entry = self._parse_media(media)
                related_results.append(entry)
                
                # Discover new seasons from this entry's relations
                for rel in entry.relations:
                    if (rel.relation_type in ("SEQUEL", "PREQUEL")
                            and rel.format == primary.format
                            and rel.id not in visited):
                        queue.append(rel.id)
                        visited.add(rel.id)
        
        if not related_results:
            return primary
        
        # Merge into primary
        all_entries = [primary] + related_results
        
        # Tags: union, keep highest rank for duplicates
        tag_map: dict[str, AniListTag] = {}
        for entry in all_entries:
            for tag in entry.tags:
                if tag.name not in tag_map or tag.rank > tag_map[tag.name].rank:
                    tag_map[tag.name] = tag
        primary.tags = list(tag_map.values())
        
        # Characters: union, deduplicate by name
        seen_chars: set[str] = set()
        merged_chars: list[AniListCharacter] = []
        for entry in all_entries:
            for char in entry.characters:
                if char.name not in seen_chars:
                    seen_chars.add(char.name)
                    merged_chars.append(char)
        primary.characters = merged_chars
        
        # Genres: union
        all_genres = set()
        for entry in all_entries:
            all_genres.update(entry.genres)
        primary.genres = sorted(all_genres)
        
        # Episodes: sum across seasons
        total_eps = sum(e.episodes or 0 for e in all_entries)
        if total_eps > 0:
            primary.episodes = total_eps
        
        # Synonyms: union 
        all_synonyms = set(primary.synonyms)
        for entry in related_results:
            all_synonyms.update(entry.synonyms)
        primary.synonyms = list(all_synonyms)
        
        # Status: use latest season's status (prefer RELEASING > NOT_YET_RELEASED > FINISHED)
        STATUS_PRIORITY = {"RELEASING": 0, "NOT_YET_RELEASED": 1, "HIATUS": 2, "FINISHED": 3, "CANCELLED": 4}
        latest_status = min(
            all_entries,
            key=lambda e: STATUS_PRIORITY.get(e.status, 5)
        ).status
        primary.status = latest_status
        
        # Relations: union from all entries (for downstream franchise detection)
        seen_rel_ids = {r.id for r in primary.relations}
        for entry in related_results:
            for rel in entry.relations:
                if rel.id not in seen_rel_ids and rel.id != primary.id:
                    seen_rel_ids.add(rel.id)
                    primary.relations.append(rel)
        
        seasons = len(all_entries)
        logger.info(f"[AniList] Merged {seasons} seasons (depth={depth}): {total_eps} episodes, "
              f"{len(primary.characters)} characters, {len(primary.tags)} tags, "
              f"status={primary.status}")
        
        return primary
    
    async def get_franchise_entries(self, title: str) -> list[dict]:
        """
        Discover distinct franchise entries for disambiguation.
        
        Strategy (optimized for API rate limits):
        1. Search for the primary entry
        2. Walk its SEQUEL/PREQUEL chain — if a sequel has a genuinely
           different title (not a season variant), treat it as a distinct entry
        3. Read SPIN_OFF/SIDE_STORY/ALTERNATIVE from relation metadata
           (no extra API calls needed for these)
        
        Only TV/ONA format entries are included (no movies/OVAs/specials).
        
        Args:
            title: Search term (e.g., "Naruto", "Solo Leveling")
            
        Returns:
            List of distinct franchise entries for disambiguation.
            Empty list if single continuity or not found.
        """
        import re
        
        primary = await self.search(title)
        if not primary:
            return []
        
        SEASON_RELATIONS = {"SEQUEL", "PREQUEL"}
        # CHARACTER excluded: crossover cameos (Goku in ONE PIECE) aren't franchise entries
        DISTINCT_RELATIONS = {"SPIN_OFF", "SIDE_STORY", "ALTERNATIVE", "PARENT"}
        SERIES_FORMATS = {"TV", "ONA", "TV_SHORT", None}
        
        # Pattern to detect season variants (same show, different season number)
        SEASON_VARIANT_RE = re.compile(
            r'\s*(?:'
            r'Season\s+\d+'
            r'|S\d+'
            r'|\d+(?:st|nd|rd|th)\s+Season'
            r'|Part\s+\d+'
            r'|Cour\s+\d+'
            r'|(?:Part|Season)\s+(?:One|Two|Three|Four|Five)'
            r')'
            r'(?:\s*[:：\-–—]\s*.+)?$',
            re.IGNORECASE
        )
        
        loop = asyncio.get_event_loop()
        primary_title = primary.title_english or primary.title_romaji
        primary_base = SEASON_VARIANT_RE.sub('', primary_title).strip().lower()
        
        # Results: each entry is a continuity group
        # Primary gets its own group
        groups: list[dict] = [{
            "title": primary_title,
            "id": primary.id,
            "relation": "primary",
            "season_count": 1,
        }]
        
        visited: set[int] = {primary.id}
        sequel_queue: list[int] = []
        
        # Read direct relations from primary
        for rel in primary.relations:
            if rel.id in visited:
                continue
            visited.add(rel.id)
            
            if rel.relation_type in SEASON_RELATIONS and rel.format in SERIES_FORMATS:
                sequel_queue.append(rel.id)
            elif rel.relation_type in DISTINCT_RELATIONS and rel.format in SERIES_FORMATS:
                rel_title = rel.title_english or rel.title_romaji
                groups.append({
                    "title": rel_title,
                    "id": rel.id,
                    "relation": rel.relation_type.lower(),
                    "season_count": 1,
                })
        
        # Walk sequel/prequel chain
        # Key: if a sequel has a genuinely different title (not a season variant
        # of the current group's base), start a new group for it
        current_group_idx = 0  # index into groups[] for the primary
        depth = 0
        MAX_DEPTH = 10
        
        while sequel_queue and depth < MAX_DEPTH:
            depth += 1
            current_batch = list(sequel_queue)
            sequel_queue.clear()
            
            for seq_id in current_batch:
                try:
                    data = await loop.run_in_executor(
                        None, self._execute_query, FETCH_BY_ID_QUERY, {"id": seq_id}
                    )
                    media = data.get("Media")
                    if not media:
                        continue
                    
                    entry = self._parse_media(media)
                    entry_title = entry.title_english or entry.title_romaji
                    entry_base = SEASON_VARIANT_RE.sub('', entry_title).strip().lower()
                    
                    # Check if this sequel has a genuinely different title
                    current_base = SEASON_VARIANT_RE.sub(
                        '', groups[current_group_idx]["title"]
                    ).strip().lower()
                    
                    if entry_base != current_base:
                        # Distinct continuation (e.g., Naruto → Shippuden, Shippuden → Boruto)
                        current_group_idx = len(groups)
                        groups.append({
                            "title": entry_title,
                            "id": entry.id,
                            "relation": "sequel",
                            "season_count": 1,
                        })
                    else:
                        # Same show, different season — merge into current group
                        groups[current_group_idx]["season_count"] += 1
                    
                    # Continue following sequel/prequel + discover distinct relations
                    for sub_rel in entry.relations:
                        if sub_rel.id in visited:
                            continue
                        visited.add(sub_rel.id)
                        
                        if sub_rel.relation_type in SEASON_RELATIONS and sub_rel.format in SERIES_FORMATS:
                            sequel_queue.append(sub_rel.id)
                        elif sub_rel.relation_type in DISTINCT_RELATIONS and sub_rel.format in SERIES_FORMATS:
                            rel_title = sub_rel.title_english or sub_rel.title_romaji
                            groups.append({
                                "title": rel_title,
                                "id": sub_rel.id,
                                "relation": sub_rel.relation_type.lower(),
                                "season_count": 1,
                            })
                except Exception as e:
                    logger.error(f"Error fetching sequel {seq_id}: {e}")
                    continue
        
        if len(groups) <= 1:
            logger.info(f"[AniList] Franchise '{title}': single continuity "
                  f"({groups[0]['season_count']} seasons), no disambiguation needed")
            return []
        
        # Deduplicate by title (different paths can discover the same entry)
        seen_titles: set[str] = set()
        unique_groups: list[dict] = []
        for g in groups:
            if g["title"] not in seen_titles:
                seen_titles.add(g["title"])
                unique_groups.append(g)
        
        logger.info(f"Franchise '{title}': {len(unique_groups)} distinct entries")
        for r in unique_groups:
            seasons = f" ({r['season_count']} seasons)" if r['season_count'] > 1 else ""
            logger.info(f"  - {r['title']} [{r['relation']}]{seasons}")
        
        return unique_groups
    
    def _parse_media(self, media: dict) -> AniListResult:
        """Parse raw AniList media JSON into an AniListResult."""
        result = AniListResult(
            id=media.get("id", 0),
            title_romaji=media.get("title", {}).get("romaji", ""),
            title_english=media.get("title", {}).get("english"),
            title_native=media.get("title", {}).get("native"),
            synonyms=media.get("synonyms", []),
            format=media.get("format"),
            status=media.get("status", "FINISHED"),
            episodes=media.get("episodes"),
            chapters=media.get("chapters"),
            description=media.get("description"),
            country_of_origin=media.get("countryOfOrigin"),
            source=media.get("source"),
            is_adult=media.get("isAdult", False),
            start_year=media.get("startDate", {}).get("year"),
            season=media.get("season"),
            average_score=media.get("averageScore"),
            popularity=media.get("popularity"),
            genres=media.get("genres", []),
            studio=None,
        )
        
        # Parse tags
        for tag in media.get("tags", []):
            result.tags.append(AniListTag(
                name=tag.get("name", ""),
                rank=tag.get("rank", 0),
                is_spoiler=tag.get("isMediaSpoiler", False),
            ))
        
        # Parse characters from edges (has role info)
        for edge in media.get("characters", {}).get("edges", []):
            node = edge.get("node", {})
            name_data = node.get("name", {})
            
            va_list = edge.get("voiceActors", [])
            va_name = va_list[0]["name"]["full"] if va_list else None
            
            result.characters.append(AniListCharacter(
                name=name_data.get("full", ""),
                native_name=name_data.get("native"),
                role=edge.get("role", "SUPPORTING"),
                voice_actor=va_name,
            ))
        
        # Parse relations
        for edge in media.get("relations", {}).get("edges", []):
            node = edge.get("node", {})
            result.relations.append(AniListRelation(
                id=node.get("id", 0),
                title_romaji=node.get("title", {}).get("romaji", ""),
                title_english=node.get("title", {}).get("english"),
                format=node.get("format"),
                status=node.get("status"),
                media_type=node.get("type"),
                relation_type=edge.get("relationType", "OTHER"),
            ))
        
        # Parse studio
        studios = media.get("studios", {}).get("nodes", [])
        if studios:
            result.studio = studios[0].get("name")
        
        return result
