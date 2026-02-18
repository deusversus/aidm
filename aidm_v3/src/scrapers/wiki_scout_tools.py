"""
WikiScout exploration tools for agentic wiki analysis.

These tools let the WikiScout LLM explore a Fandom wiki's structure
interactively — previewing categories, checking page counts, and sampling
page content — before committing to a scraping plan.
"""

import logging
from typing import Any

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry

logger = logging.getLogger(__name__)


def build_wiki_scout_tools(
    fandom_client: Any,  # FandomClient
    wiki_url: str,
    all_categories: list[str],
) -> ToolRegistry:
    """Build tools for agentic wiki exploration.
    
    Args:
        fandom_client: FandomClient instance (for API calls)
        wiki_url: Base URL of the wiki being explored
        all_categories: Pre-fetched list of all category names
        
    Returns:
        ToolRegistry with wiki exploration tools
    """
    registry = ToolRegistry()

    # -----------------------------------------------------------------
    # CATEGORY EXPLORATION
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="list_categories",
        description=(
            "List all available category names from this wiki. "
            "Use this first to see what the wiki contains."
        ),
        parameters=[
            ToolParam("filter", "str",
                      "Optional substring filter (e.g., 'Character' to only see character-related categories)",
                      required=False),
        ],
        handler=lambda filter="": _list_categories(all_categories, filter)
    ))

    registry.register(ToolDefinition(
        name="get_category_size",
        description=(
            "Check how many pages a specific category contains. "
            "Use this to assess if a category is worth scraping."
        ),
        parameters=[
            ToolParam("category", "str", "Exact category name", required=True),
        ],
        handler=lambda category: _get_category_size(fandom_client, wiki_url, category)
    ))

    registry.register(ToolDefinition(
        name="preview_category",
        description=(
            "Get the first 10 page titles from a category. "
            "Use this to verify a category actually contains relevant content."
        ),
        parameters=[
            ToolParam("category", "str", "Exact category name", required=True),
        ],
        handler=lambda category: _preview_category(fandom_client, wiki_url, category)
    ))

    # -----------------------------------------------------------------
    # PAGE EXPLORATION
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="preview_page",
        description=(
            "Get a preview (first 500 chars) of a wiki page's content. "
            "Use this to check if a page category has the type of content you expect."
        ),
        parameters=[
            ToolParam("title", "str", "Exact page title", required=True),
        ],
        handler=lambda title: _preview_page(fandom_client, wiki_url, title)
    ))

    registry.register(ToolDefinition(
        name="search_wiki",
        description=(
            "Search the wiki for pages matching a query. "
            "Returns matching page titles."
        ),
        parameters=[
            ToolParam("query", "str", "Search query", required=True),
            ToolParam("limit", "int", "Max results (default 10)", required=False),
        ],
        handler=lambda query, limit=10: _search_wiki(fandom_client, wiki_url, query, int(limit))
    ))

    return registry


# =========================================================================
# Tool Handlers
# =========================================================================

def _list_categories(all_categories: list[str], filter_str: str = "") -> dict:
    """List categories with optional filtering."""
    if filter_str:
        filtered = [c for c in all_categories if filter_str.lower() in c.lower()]
        return {
            "total_categories": len(all_categories),
            "matching_filter": filter_str,
            "count": len(filtered),
            "categories": filtered[:50],  # Cap output
        }
    return {
        "total_categories": len(all_categories),
        "categories": all_categories[:100],  # Cap output at 100
    }


def _get_category_size(client, wiki_url: str, category: str) -> dict:
    """Get page count for a category."""
    try:
        members = client._get_category_members(wiki_url, category, limit=200)
        return {
            "category": category,
            "page_count": len(members),
            "sample_titles": members[:5],
        }
    except Exception as e:
        return {"error": f"Failed to query category '{category}': {e}"}


def _preview_category(client, wiki_url: str, category: str) -> dict:
    """Get first 10 page titles from a category."""
    try:
        members = client._get_category_members(wiki_url, category, limit=10)
        return {
            "category": category,
            "page_count": len(members),
            "pages": members,
        }
    except Exception as e:
        return {"error": f"Failed to preview category '{category}': {e}"}


def _preview_page(client, wiki_url: str, title: str) -> dict:
    """Get a preview of a wiki page."""
    try:
        page = client._parse_page(wiki_url, title)
        if page:
            preview = page.clean_text[:500] if page.clean_text else "(empty page)"
            return {
                "title": page.title,
                "text_length": page.clean_text_length,
                "sections": page.sections[:8],  # First 8 section headings
                "preview": preview,
                "categories": page.categories[:5],
            }
        return {"error": f"Page '{title}' not found"}
    except Exception as e:
        return {"error": f"Failed to fetch page '{title}': {e}"}


def _search_wiki(client, wiki_url: str, query: str, limit: int = 10) -> dict:
    """Search wiki for pages matching query."""
    try:
        params = {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": min(limit, 20),
            "format": "json",
        }
        data = client._api_query(wiki_url, params)
        if data and "query" in data and "search" in data["query"]:
            results = data["query"]["search"]
            return {
                "query": query,
                "total_hits": data["query"].get("searchinfo", {}).get("totalhits", len(results)),
                "results": [
                    {
                        "title": r["title"],
                        "snippet": r.get("snippet", "")[:200],
                    }
                    for r in results
                ],
            }
        return {"query": query, "total_hits": 0, "results": []}
    except Exception as e:
        return {"error": f"Search failed: {e}"}
