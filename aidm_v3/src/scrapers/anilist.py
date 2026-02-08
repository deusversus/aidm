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
        print(f"[AniList] Disambiguated: chose '{chosen_title}' ({chosen_fmt}) from {len(media_list)} candidates")
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
