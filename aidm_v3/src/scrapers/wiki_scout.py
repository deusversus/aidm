"""
WikiScout — LLM-guided Fandom wiki category classification.

Replaces the rigid alias-based category normalizer (wiki_normalize.py) with a
single LLM call that classifies wiki categories into RPG-relevant types.

Flow:
    1. FandomClient._get_all_categories() → ~161 category names
    2. plan_wiki_scrape() → LLM classifies via complete_with_schema → WikiScrapePlan
    3. Code executes the plan (fetch members, parse pages)
"""

import logging
from typing import List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic schemas for LLM structured output
# ---------------------------------------------------------------------------

CANONICAL_TYPES = [
    "characters", "techniques", "locations", "arcs",
    "factions", "items", "lore",
]

class CategorySelection(BaseModel):
    """A single wiki category selected for scraping."""
    wiki_category: str = Field(description="Exact category name from the wiki")
    canonical_type: str = Field(description="One of: characters, techniques, locations, arcs, factions, items, lore")
    priority: int = Field(description="1=must scrape, 2=good to have, 3=nice-to-have")
    reasoning: str = Field(description="Brief justification for this selection")


class WikiScrapePlan(BaseModel):
    """Structured scraping plan produced by the LLM."""
    categories: List[CategorySelection] = Field(
        description="Categories to scrape, ordered by priority"
    )
    ip_notes: str = Field(
        default="",
        description="IP-specific observations (e.g. 'sci-fi — no power system, uses Technology/Weapons instead')"
    )


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

WIKI_SCOUT_SYSTEM = """You are a wiki category classifier for an anime RPG game engine.

Given a list of category names from a Fandom wiki, select the categories that contain 
RPG-relevant lore pages. Map each to a canonical type.

## Canonical Types

| Type | What it covers |
|------|----------------|
| characters | Player characters, NPCs, antagonists, supporting cast |
| techniques | Abilities, powers, fighting styles, magic systems, jutsu, quirks |
| locations | Places, settings, regions, cities, worlds |
| arcs | Story arcs, sagas, seasons, major story events |
| factions | Organizations, guilds, clans, teams, military units, governments |
| items | Weapons, technology, equipment, artifacts, tools, vehicles |
| lore | Terminology, concepts, species, races, mythology, world rules |

## Rules

1. **Pick the BROADEST container category for each type.** Prefer "Characters" over "Male Characters" or "Antagonists". Pick the one that contains the most relevant pages.

2. **You may pick MULTIPLE categories per type** if they cover genuinely different content (e.g. "Jutsu" and "Kekkei Genkai" are both valid techniques categories).

3. **Priority**:
   - 1 = essential for RPG (characters, main abilities, key locations)
   - 2 = valuable context (factions, arcs, secondary abilities)  
   - 3 = nice-to-have (trivia, minor lore)

4. **Not every IP has every type.** Death Note has no "techniques". Vinland Saga has no power system. That's fine — don't force categories into types they don't fit.

## COMMON PITFALLS — avoid these:

- **Image/gallery categories** (e.g. "Character Images", "Chapter 17 Images") — contain media files, NOT article pages. ALWAYS SKIP.
- **Template/navigation categories** (e.g. "Arc navigation templates", "Infobox templates") — wiki infrastructure. SKIP.
- **"Images by X"** categories — ALWAYS SKIP these.
- **Subset categories used for grouping** (e.g. "Characters by location", "Characters by organization") — these group characters, not locations/organizations. Classify by what the PAGES actually are.
- **Single-entity categories** (e.g. "Beyond's Expedition Team", "Ackerman clan") — these are individual factions, not container categories. Only select if no broader "Organizations"/"Factions"/"Groups" category exists.
- **Stub/maintenance categories** (e.g. "Stubs", "Articles needing cleanup") — SKIP.
- **British vs American spelling** is fine — "Organisation" IS a valid factions category.
- **Format/media categories** (e.g. "Volume 1", "Episode 12", "Chapter 45") — individual episode/chapter categories are noise. Only select a broad "Episodes" or "Story Arcs" category.

## IP-Specific Guidance

- Sci-fi series often use "Technology", "Weapons", "Ships" instead of traditional "Techniques"
- Fantasy series may have "Magic", "Spells", "Enchantments"
- Mecha series have "Mobile Suits", "Mobile Weapons", "Mecha"
- Some series have "Races", "Species", "Creatures" — classify as "lore"
"""


WIKI_SCOUT_USER_TEMPLATE = """Anime/Manga: {anime_title}
Wiki URL: {wiki_url}

Here are ALL {count} categories from this wiki. Select the ones worth scraping:

{category_list}
"""


# ---------------------------------------------------------------------------
# Main function
# ---------------------------------------------------------------------------

async def plan_wiki_scrape(
    wiki_url: str,
    anime_title: str,
    all_categories: List[str],
) -> WikiScrapePlan:
    """Use an LLM to classify wiki categories into a structured scraping plan.
    
    Args:
        wiki_url: The Fandom wiki base URL
        anime_title: The anime/manga title (for context)
        all_categories: List of all category names from the wiki
        
    Returns:
        WikiScrapePlan with categorized selections
    """
    from ..llm import get_llm_manager
    
    manager = get_llm_manager()
    provider, model = manager.get_provider_for_agent("wiki_scout")
    
    # Format category list (numbered for clarity)
    category_list = "\n".join(f"{i+1}. {cat}" for i, cat in enumerate(all_categories))
    
    user_message = WIKI_SCOUT_USER_TEMPLATE.format(
        anime_title=anime_title,
        wiki_url=wiki_url,
        count=len(all_categories),
        category_list=category_list,
    )
    
    logger.info(
        f"[WikiScout] Classifying {len(all_categories)} categories "
        f"from {wiki_url} for '{anime_title}'..."
    )
    
    try:
        plan = await provider.complete_with_schema(
            messages=[{"role": "user", "content": user_message}],
            schema=WikiScrapePlan,
            system=WIKI_SCOUT_SYSTEM,
            model=model,
            max_tokens=2048,
        )
        
        # Validate canonical types
        valid = []
        for sel in plan.categories:
            if sel.canonical_type not in CANONICAL_TYPES:
                logger.warning(
                    f"[WikiScout] Skipping '{sel.wiki_category}' — "
                    f"unknown type '{sel.canonical_type}'"
                )
                continue
            valid.append(sel)
        plan.categories = valid
        
        # Log summary
        type_counts = {}
        for sel in plan.categories:
            type_counts[sel.canonical_type] = type_counts.get(sel.canonical_type, 0) + 1
        
        logger.info(
            f"[WikiScout] Plan: {len(plan.categories)} categories across "
            f"{len(type_counts)} types: {type_counts}"
        )
        if plan.ip_notes:
            logger.info(f"[WikiScout] Notes: {plan.ip_notes}")
        
        return plan
        
    except Exception as e:
        logger.error(f"[WikiScout] LLM classification failed: {e}")
        # Return empty plan — caller should fall back to legacy normalizer
        return WikiScrapePlan(
            categories=[],
            ip_notes=f"WikiScout failed: {e}. Falling back to legacy discovery.",
        )
