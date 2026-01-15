"""
Source trust tiers for web research.

Defines domain-based trust levels to guide LLM synthesis of search results.
"""

from typing import Dict
from urllib.parse import urlparse


# Domain trust tiers
DOMAIN_TRUST: Dict[str, str] = {
    # Tier 1 - HIGH trust (curated/official)
    "wikipedia.org": "HIGH",
    "en.wikipedia.org": "HIGH",
    "myanimelist.net": "HIGH",
    "anilist.co": "HIGH",
    "anidb.net": "HIGH",
    
    # Tier 2 - MEDIUM trust (community-maintained)
    "fandom.com": "MEDIUM",
    "wikia.com": "MEDIUM",  # Old fandom domain
    "reddit.com": "MEDIUM",
    "crunchyroll.com": "MEDIUM",
    "funimation.com": "MEDIUM",
    "animenewsnetwork.com": "MEDIUM",
    
    # Explicit LOW trust (SEO farms, AI content)
    "cbr.com": "LOW",
    "screenrant.com": "LOW",
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
- wikipedia.org, myanimelist.net, anilist.co, anidb.net

**MEDIUM TRUST** (supplement, verify against HIGH):
- fandom.com wikis, reddit.com, crunchyroll.com, animenewsnetwork.com

**LOW TRUST** (verify against multiple other sources):
- Other sites, SEO content farms

If sources conflict, prefer HIGH trust sources. Note any discrepancies.
"""
