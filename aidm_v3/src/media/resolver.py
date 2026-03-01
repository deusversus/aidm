"""Portrait media resolver — post-KA narrative processing.

Scans KA output for known NPC/character names and builds a portrait_map
from the database. Also handles legacy {{Name}} markers by converting
them to bold markdown.
"""

import logging
import re

logger = logging.getLogger(__name__)

# Legacy pattern: {{Name}} markers (kept for backwards compatibility)
PORTRAIT_MARKER = re.compile(r'\{\{([A-Za-z][A-Za-z\' ]{0,50}?)\}\}')


def resolve_portraits(
    narrative: str,
    campaign_id: int,
    session=None,
) -> tuple[str, dict[str, str]]:
    """Scan narrative for known NPC/character names and resolve portrait URLs.
    
    The KA naturally bolds character names (**Name**) in its output.
    This function scans the narrative for any known NPC or PC names
    and builds a portrait_map for those that have portrait_url set.
    
    Also handles legacy {{Name}} markers by converting to **Name**.
    
    Args:
        narrative: KA narrative output
        campaign_id: Current campaign ID for DB lookup
        session: Optional SQLAlchemy session (creates one if not provided)
        
    Returns:
        (cleaned_narrative, portrait_map) where:
        - cleaned_narrative has any {{Name}} markers replaced with **Name**
        - portrait_map is {"Name": "/api/game/media/..."} for names with portraits
    """
    portrait_map: dict[str, str] = {}

    try:
        from src.db.models import NPC, Character
        from src.db.session import create_session

        db = session or create_session()
        close_session = session is None

        try:
            # Get ALL NPCs for this campaign (not just those with portraits)
            npcs = db.query(NPC).filter(
                NPC.campaign_id == campaign_id,
            ).all()

            # Build name -> portrait_url lookup
            # Include first-name aliases (e.g. "Kota" for "Kota Blackfire")
            name_to_url: dict[str, str | None] = {}
            canonical_names: dict[str, str] = {}  # lowercase -> display name
            for npc in npcs:
                if not npc.name:
                    continue
                name_to_url[npc.name.lower()] = npc.portrait_url
                canonical_names[npc.name.lower()] = npc.name
                # First-name alias
                if ' ' in npc.name:
                    first = npc.name.split()[0]
                    if first.lower() not in name_to_url:
                        name_to_url[first.lower()] = npc.portrait_url
                        canonical_names[first.lower()] = first

            # Also check the player character
            char = db.query(Character).filter(
                Character.campaign_id == campaign_id,
            ).first()
            if char and char.name:
                name_to_url[char.name.lower()] = char.portrait_url
                canonical_names[char.name.lower()] = char.name
                if ' ' in char.name:
                    first = char.name.split()[0]
                    if first.lower() not in name_to_url:
                        name_to_url[first.lower()] = char.portrait_url
                        canonical_names[first.lower()] = first

            # Scan narrative for known names using word-boundary regex
            narrative_lower = narrative.lower()
            for name_lower, url in name_to_url.items():
                if url and name_lower in narrative_lower:
                    # Verify it's a word boundary match (not substring of another word)
                    pattern = re.compile(r'\b' + re.escape(name_lower) + r'\b', re.IGNORECASE)
                    if pattern.search(narrative):
                        display_name = canonical_names[name_lower]
                        portrait_map[display_name] = url

        finally:
            if close_session:
                db.close()

    except Exception as e:
        # Resolution failure should never break the narrative
        logger.error(f"Portrait lookup failed: {e}")

    # Handle legacy {{Name}} markers → convert to **Name**
    if '{{' in narrative:
        def replace_marker(match):
            name = match.group(1)
            return f"**{name}**"
        narrative = PORTRAIT_MARKER.sub(replace_marker, narrative)

    if portrait_map:
        logger.info(f"Resolved {len(portrait_map)} portraits: {list(portrait_map.keys())}")

    return narrative, portrait_map
