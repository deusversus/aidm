"""
Intent Resolution Tools — ToolRegistry for the Intent Resolution Agent.

These tools let the agent search, verify, and map anime/manga titles
to canonical identifiers before committing to profile creation.

Tool inventory:
    search_anilist       — Multi-result search returning all candidates
    fetch_anilist_by_id  — Verify a specific AniList entry by ID
    get_franchise_graph  — Map all franchise entries from one AniList ID
    search_local_profiles — Find existing profiles that might match
    confirm_with_user    — Request disambiguation from the user
"""

import logging
from pathlib import Path
from typing import Any

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry

logger = logging.getLogger(__name__)


# ─── Tool Implementations ────────────────────────────────────────────────


async def _search_anilist(client, title: str, media_type: str = "ANIME") -> list[dict]:
    """Search AniList and return all candidates."""
    from ..scrapers.anilist import AniListResult

    results = await client.search_multi(title, media_type=media_type)
    if not results:
        return [{"info": f"No results found for '{title}' (type={media_type})"}]

    return [
        {
            "anilist_id": r.id,
            "mal_id": r.mal_id,
            "title_english": r.title_english,
            "title_romaji": r.title_romaji,
            "format": r.format,
            "status": r.status,
            "episodes": r.episodes,
            "start_year": r.start_year,
            "popularity": r.popularity,
            "genres": r.genres[:5],  # Limit for brevity
            "studio": r.studio,
        }
        for r in results
    ]


async def _fetch_anilist_by_id(client, anilist_id: int) -> dict:
    """Fetch a single AniList entry by its ID."""
    result = await client.fetch_by_id(anilist_id)
    if not result:
        return {"error": f"No entry found for AniList ID {anilist_id}"}

    return {
        "anilist_id": result.id,
        "mal_id": result.mal_id,
        "title_english": result.title_english,
        "title_romaji": result.title_romaji,
        "title_native": result.title_native,
        "synonyms": result.synonyms[:5],
        "format": result.format,
        "status": result.status,
        "episodes": result.episodes,
        "chapters": result.chapters,
        "start_year": result.start_year,
        "genres": result.genres,
        "studio": result.studio,
        "description": (result.description or "")[:300],
        "source": result.source,
        "country_of_origin": result.country_of_origin,
        "relations": [
            {
                "id": rel.id,
                "title": rel.title_english or rel.title_romaji,
                "type": rel.relation_type,
                "format": rel.format,
            }
            for rel in result.relations[:10]
        ],
    }


async def _get_franchise_graph(client, anilist_id: int) -> list[dict]:
    """Get franchise graph from an AniList ID."""
    entries = await client.get_franchise_graph_by_id(anilist_id)
    if not entries:
        return [{"info": f"No franchise graph found or single-entry franchise for ID {anilist_id}"}]
    return entries


def _search_local_profiles(profiles_dir: Path, query: str) -> list[dict]:
    """Search existing local profiles by fuzzy title matching."""
    from ..profiles.loader import find_profile_by_title, load_profile

    match = find_profile_by_title(query)
    if not match:
        return [{"info": f"No local profiles match '{query}'"}]

    profile_id, match_type = match

    # Try to load the profile for richer info
    result = {
        "profile_id": profile_id,
        "match_type": match_type,
    }

    try:
        profile = load_profile(profile_id, fallback=False)
        result["name"] = profile.name
        result["anilist_id"] = profile.anilist_id
        result["source"] = profile.source
        result["already_exists"] = True
    except Exception:
        result["name"] = profile_id.replace("_", " ").title()
        result["already_exists"] = True  # YAML exists even if load fails

    return [result]


# ─── Tool Registry Builder ──────────────────────────────────────────────


def build_intent_resolution_tools(
    anilist_client=None,
    profiles_dir: Path | None = None,
) -> ToolRegistry:
    """Build the tool registry for the Intent Resolution Agent.

    Args:
        anilist_client: Optional AniListClient instance (created lazily if None)
        profiles_dir: Directory containing profile YAML files

    Returns:
        ToolRegistry with all intent resolution tools registered
    """
    from ..scrapers.anilist import AniListClient

    if anilist_client is None:
        anilist_client = AniListClient()

    if profiles_dir is None:
        profiles_dir = Path(__file__).parent.parent / "profiles"

    registry = ToolRegistry()

    # ── search_anilist ──
    async def search_anilist_handler(title: str, media_type: str = "ANIME"):
        return await _search_anilist(anilist_client, title, media_type)

    registry.register(ToolDefinition(
        name="search_anilist",
        description=(
            "Search AniList for anime/manga matching a title. Returns ALL candidates "
            "(not just best match) so you can reason about which entry the user means. "
            "Use this as your FIRST tool when resolving a user's anime/manga reference."
        ),
        parameters=[
            ToolParam(name="title", type="string", description="Search query (anime/manga title)", required=True),
            ToolParam(name="media_type", type="string", description="'ANIME' or 'MANGA' (default: ANIME)", required=False),
        ],
        handler=search_anilist_handler,
    ))

    # ── fetch_anilist_by_id ──
    async def fetch_by_id_handler(anilist_id: int):
        return await _fetch_anilist_by_id(anilist_client, int(anilist_id))

    registry.register(ToolDefinition(
        name="fetch_anilist_by_id",
        description=(
            "Fetch full details for a specific AniList entry by its numeric ID. "
            "Use this AFTER search_anilist to verify a candidate, or to look up "
            "an entry whose ID you already know. Returns canonical title, genres, "
            "relations, description, and more."
        ),
        parameters=[
            ToolParam(name="anilist_id", type="integer", description="AniList media ID", required=True),
        ],
        handler=fetch_by_id_handler,
    ))

    # ── get_franchise_graph ──
    async def franchise_graph_handler(anilist_id: int):
        return await _get_franchise_graph(anilist_client, int(anilist_id))

    registry.register(ToolDefinition(
        name="get_franchise_graph",
        description=(
            "Map the entire franchise from a single AniList ID. Returns all related "
            "entries (sequels, spin-offs, side stories) grouped by continuity. "
            "Use this to understand franchise structure when the user mentions an IP "
            "that could span multiple series (e.g., 'Dragon Ball', 'Naruto', 'Gundam')."
        ),
        parameters=[
            ToolParam(name="anilist_id", type="integer", description="AniList media ID to start from", required=True),
        ],
        handler=franchise_graph_handler,
    ))

    # ── search_local_profiles ──
    def search_local_handler(query: str):
        return _search_local_profiles(profiles_dir, query)

    registry.register(ToolDefinition(
        name="search_local_profiles",
        description=(
            "Search existing local profiles that have already been generated. "
            "Use this to check if a profile already exists before triggering "
            "new research/generation. Returns profile ID, name, AniList ID, "
            "and match confidence."
        ),
        parameters=[
            ToolParam(name="query", type="string", description="Title to search for in local profiles", required=True),
        ],
        handler=search_local_handler,
    ))

    return registry
