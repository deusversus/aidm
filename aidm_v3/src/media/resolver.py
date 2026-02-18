"""Portrait media resolver — post-KA narrative processing.

Scans KA output for {{NPC_Name}} annotations and resolves them
to portrait URLs from the database. Falls back to bold text if
no portrait exists.
"""

import logging
import re

logger = logging.getLogger(__name__)

# Pattern matches {{Name}} with 1-3 words (covers "Sasuke", "Gojo Satoru", etc.)
PORTRAIT_MARKER = re.compile(r'\{\{([A-Za-z][A-Za-z\' ]{0,50}?)\}\}')


def resolve_portraits(
    narrative: str,
    campaign_id: int,
    session=None,
) -> tuple[str, dict[str, str]]:
    """Resolve {{NPC_Name}} markers in narrative to portrait URLs.
    
    Args:
        narrative: Raw KA output with optional {{Name}} markers
        campaign_id: Current campaign ID for DB lookup
        session: Optional SQLAlchemy session (creates one if not provided)
        
    Returns:
        (cleaned_narrative, portrait_map) where:
        - cleaned_narrative has {{Name}} replaced with **Name**
        - portrait_map is {"Name": "/api/game/media/..."} for names with portraits
    """
    # Find all unique names in markers
    matches = PORTRAIT_MARKER.findall(narrative)
    if not matches:
        return narrative, {}

    unique_names = list(dict.fromkeys(matches))  # Preserve order, dedupe

    # Look up portrait URLs from DB
    portrait_map: dict[str, str] = {}

    try:
        from src.db.models import NPC, Character
        from src.db.session import create_session

        db = session or create_session()
        close_session = session is None

        try:
            # Check NPCs first (most common case)
            npcs = db.query(NPC).filter(
                NPC.campaign_id == campaign_id,
                NPC.portrait_url.isnot(None),
            ).all()

            # Build a name -> portrait_url lookup (case-insensitive)
            npc_lookup = {}
            for npc in npcs:
                npc_lookup[npc.name.lower()] = npc.portrait_url

            # Also check the player character
            char = db.query(Character).filter(
                Character.campaign_id == campaign_id,
                Character.portrait_url.isnot(None),
            ).first()

            if char:
                npc_lookup[char.name.lower()] = char.portrait_url

            # Resolve each unique name
            for name in unique_names:
                url = npc_lookup.get(name.lower())
                if url:
                    portrait_map[name] = url
        finally:
            if close_session:
                db.close()

    except Exception as e:
        # Resolution failure should never break the narrative
        logger.error(f"Portrait lookup failed: {e}")

    # Replace all {{Name}} markers with **Name** (bold fallback)
    def replace_marker(match):
        name = match.group(1)
        return f"**{name}**"

    cleaned = PORTRAIT_MARKER.sub(replace_marker, narrative)

    if portrait_map:
        logger.info(f"Resolved {len(portrait_map)}/{len(unique_names)} portraits: {list(portrait_map.keys())}")

    return cleaned, portrait_map
