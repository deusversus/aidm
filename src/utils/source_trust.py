"""
Source trust tiers for web research.

Defines domain-based trust levels to guide LLM synthesis of search results.
"""

from urllib.parse import urlparse

# Domain trust tiers
DOMAIN_TRUST: dict[str, str] = {
    # ----------------------------------------------------------------
    # HIGH trust — curated databases, official sources, or
    # community wikis with strict sourcing and editorial standards
    # ----------------------------------------------------------------
    "wikipedia.org": "HIGH",
    "en.wikipedia.org": "HIGH",
    "myanimelist.net": "HIGH",
    "anilist.co": "HIGH",
    "anidb.net": "HIGH",
    "mangaupdates.com": "HIGH",            # Curated manga metadata database
    "vsbattles.fandom.com": "HIGH",        # Canonical power-scaling wiki; strict sourcing; best for combat stats/tiers
    "vsbattles.wikia.com": "HIGH",         # Old domain alias for VS Battles
    "viz.com": "HIGH",                     # Official US manga/anime publisher
    "shonenjump.com": "HIGH",              # Official Shonen Jump
    "mangaplus.shueisha.co.jp": "HIGH",    # Official Shueisha manga reader

    # ----------------------------------------------------------------
    # MEDIUM trust — community-maintained or journalism with
    # reasonable editorial standards; good signal, verify against HIGH
    # ----------------------------------------------------------------
    "fandom.com": "MEDIUM",
    "wikia.com": "MEDIUM",                 # Old fandom domain
    "reddit.com": "MEDIUM",
    "crunchyroll.com": "MEDIUM",
    "funimation.com": "MEDIUM",
    "animenewsnetwork.com": "MEDIUM",
    "anime-planet.com": "MEDIUM",          # Community anime/manga database
    "animeplanet.com": "MEDIUM",           # Redirect alias for anime-planet.com
    "kitsu.io": "MEDIUM",                  # Anime/manga tracking database
    "tvtropes.org": "MEDIUM",              # Reliable for tropes, genre tags, story structure
    "nautiljon.com": "MEDIUM",             # Well-curated French anime database
    "anisearch.com": "MEDIUM",             # International anime/manga database
    "livechart.me": "MEDIUM",              # Accurate airing schedules and metadata
    "mangadex.org": "MEDIUM",              # Largest scanlation host; useful for chapter/alt-version info
    "comicbook.com": "MEDIUM",             # Mixed quality but covers major announcements

    # ----------------------------------------------------------------
    # LOW trust — SEO content farms, AI-generated listicles,
    # high-volume low-quality anime content
    # ----------------------------------------------------------------
    "cbr.com": "LOW",
    "screenrant.com": "LOW",
    "gamerant.com": "LOW",
    "sportskeeda.com": "LOW",              # High-volume, low-quality anime coverage
    "epicstream.com": "LOW",
    "distractify.com": "LOW",
    "hitc.com": "LOW",
    "thenerdstash.com": "LOW",
    "otakusnotes.com": "LOW",
    "animehype.com": "LOW",
    "movieweb.com": "LOW",
}


def get_trust_level(url: str) -> str:
    """
    Get trust level for a URL.
    
    Args:
        url: Full URL or domain
        
    Returns:
        Trust level: "HIGH", "MEDIUM", or "LOW"
    """
    try:
        # Extract domain from URL
        if "://" in url:
            domain = urlparse(url).netloc
        else:
            domain = url

        # Remove www. prefix
        domain = domain.replace("www.", "")

        # Check exact match
        if domain in DOMAIN_TRUST:
            return DOMAIN_TRUST[domain]

        # Check if domain ends with a known domain
        for known_domain, trust in DOMAIN_TRUST.items():
            if domain.endswith(known_domain):
                return trust

        # Default to LOW
        return "LOW"
    except Exception:
        return "LOW"


def get_trust_guidance_prompt() -> str:
    """
    Get the system prompt guidance for source prioritization.
    
    Returns:
        String to append to system prompts.
    """
    return """
## Source Prioritization
When synthesizing information from web sources, prioritize by trust level:

**HIGH TRUST** (use as primary source):
- wikipedia.org, myanimelist.net, anilist.co, anidb.net, mangaupdates.com
- vsbattles.fandom.com (canonical power-scaling wiki — best for combat stats, ability tiers, VS comparisons)
- viz.com, shonenjump.com, mangaplus.shueisha.co.jp (official publishers)

**MEDIUM TRUST** (supplement, verify against HIGH):
- fandom.com wikis, reddit.com, crunchyroll.com, animenewsnetwork.com
- anime-planet.com, kitsu.io, tvtropes.org, comicbook.com

**LOW TRUST** (treat with skepticism, verify against multiple other sources):
- cbr.com, screenrant.com, gamerant.com, sportskeeda.com, epicstream.com
- Any site producing high-volume listicles or AI-generated anime content

If sources conflict, prefer HIGH trust sources. Note significant discrepancies.
"""
