"""
Wiki Category Discovery & Normalization for AIDM v3.

Fandom wikis use inconsistent category names across different IPs.
This module discovers the actual categories for a given wiki and maps
them to our canonical types (characters, techniques, locations, arcs, factions).

Examples of cross-wiki variation:
  - Naruto:        "Jutsu"          → techniques
  - JJK:           "Cursed Techniques" → techniques
  - Vampire Hunter D: "Abilities"   → techniques
  - MHA:           "Quirks"         → techniques
"""

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


# ─── Canonical Category Types ────────────────────────────────────────────────

CANONICAL_TYPES = ["characters", "techniques", "locations", "arcs", "factions"]

# Alias lists ordered by specificity (most common first, IP-specific later)
CATEGORY_ALIASES: dict[str, list[str]] = {
    "characters": [
        "Characters", "Character", "Cast", "Main Characters",
        "Protagonists", "Antagonists", "Male Characters", "Female Characters",
    ],
    "techniques": [
        "Techniques", "Abilities", "Skills", "Powers", "Magic",
        "Special Moves", "Super Moves", "Attacks",
        # IP-specific
        "Jutsu", "Ninjutsu", "Genjutsu", "Taijutsu",
        "Quirks", "Nen Abilities", "Devil Fruits", "Stands",
        "Cursed Techniques", "Innate Techniques",
        "Breathing Styles", "Blood Demon Arts",
        "Domains",  # JJK Domain Expansions
        "Spells", "Magecraft",  # Fate/Nasuverse
        "Sacred Gears",  # DxD
        "Bankai",  # Bleach
    ],
    "locations": [
        "Locations", "Places", "Settings", "Areas",
        "Countries", "Cities", "Villages", "Worlds",
        "Regions", "Realms",
    ],
    "arcs": [
        "Story Arcs", "Arcs", "Story arcs",
        "Sagas", "Seasons",
        "Episodes", "Chapters",  # Less ideal but sometimes all that exists
    ],
    "factions": [
        "Organizations", "Factions", "Groups",
        "Clans", "Guilds", "Teams",
        "Affiliations", "Alliances", "Military",
        "Nations", "Kingdoms",
    ],
}

# Substring patterns for fuzzy fallback discovery
SUBSTRING_PATTERNS: dict[str, list[str]] = {
    "characters": ["character"],
    "techniques": ["technique", "ability", "skill", "power", "jutsu", "quirk", "magic", "spell"],
    "locations": ["location", "place", "area", "region"],
    "arcs": ["arc", "saga"],
    "factions": ["organization", "faction", "group", "clan", "guild", "team"],
}


# ─── Discovery Result ────────────────────────────────────────────────────────

@dataclass
class CategoryMapping:
    """Result of category discovery for a single wiki."""
    wiki_url: str
    total_categories: int = 0
    
    # canonical_type -> list of matching wiki category names
    discovered: dict[str, list[str]] = field(default_factory=dict)
    
    # canonical_type -> primary category name (first match, used for scraping)
    primary: dict[str, str | None] = field(default_factory=dict)
    
    @property
    def discovery_rate(self) -> str:
        found = sum(1 for v in self.primary.values() if v is not None)
        return f"{found}/{len(CANONICAL_TYPES)}"
    
    @property
    def types_found(self) -> list[str]:
        return [k for k, v in self.primary.items() if v is not None]
    
    @property
    def types_missing(self) -> list[str]:
        return [k for k, v in self.primary.items() if v is None]


# ─── Discovery Logic ─────────────────────────────────────────────────────────

def discover_categories(all_category_names: list[str], wiki_url: str = "") -> CategoryMapping:
    """
    Given all category names from a wiki, find which ones match our canonical types.
    
    Uses two strategies:
    1. Exact alias matching (case-insensitive)
    2. Substring fallback for unmatched types
    
    Args:
        all_category_names: List of all category names from the wiki
        wiki_url: URL of the wiki (for logging/identification)
        
    Returns:
        CategoryMapping with discovered categories
    """
    mapping = CategoryMapping(
        wiki_url=wiki_url,
        total_categories=len(all_category_names),
    )
    
    # Build case-insensitive lookup
    lower_to_original = {c.lower(): c for c in all_category_names}
    
    for canonical_type in CANONICAL_TYPES:
        matches = []
        
        # Strategy 1: Exact alias matching
        aliases = CATEGORY_ALIASES.get(canonical_type, [])
        for alias in aliases:
            if alias.lower() in lower_to_original:
                matches.append(lower_to_original[alias.lower()])
        
        # Strategy 2: Substring fallback (only if no exact match)
        if not matches:
            patterns = SUBSTRING_PATTERNS.get(canonical_type, [])
            for cat_name in all_category_names:
                cat_lower = cat_name.lower()
                for pattern in patterns:
                    if pattern in cat_lower and cat_name not in matches:
                        matches.append(cat_name)
        
        mapping.discovered[canonical_type] = matches
        mapping.primary[canonical_type] = matches[0] if matches else None
    
    # Log results
    found = mapping.types_found
    missing = mapping.types_missing
    logger.info(
        f"Category discovery for {wiki_url}: "
        f"{len(found)}/{len(CANONICAL_TYPES)} types found "
        f"({', '.join(found) if found else 'none'})"
    )
    if missing:
        logger.info(f"  Missing types: {', '.join(missing)}")
    
    return mapping
