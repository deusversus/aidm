"""Session Zero profile research functions.

Split from session_zero.py for maintainability.
Contains all profile disambiguation, research, hybrid merge,
and custom profile generation logic.
"""

from typing import Optional, Dict, Any, List

from ..core.session import Session
from typing import TYPE_CHECKING

import logging

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from .progress import ProgressTracker


async def get_disambiguation_options(anime_name: str) -> Dict[str, Any]:
    """
    Check if an anime name needs disambiguation before loading/generating.
    
    Uses AniList's relation graph to find distinct franchise entries,
    correctly collapsing seasons (SEQUEL/PREQUEL) and surfacing only
    genuinely distinct series (SPIN_OFF, SIDE_STORY, ALTERNATIVE, etc).
    
    Falls back to LLM web search for titles not found on AniList.
    
    Args:
        anime_name: What the user typed (e.g., "dbz", "naruto")
        
    Returns:
        Dict with:
        - 'needs_disambiguation': bool
        - 'options': List[Dict] with name, id, relation_type for each option
        - 'source': 'anilist' or 'web_search'
    """
    result = {
        'needs_disambiguation': False,
        'options': [],
        'source': None
    }
    
    # Step 1: Try AniList relation graph (fast, deterministic, season-aware)
    logger.info(f"Checking AniList for '{anime_name}' franchise...")
    try:
        from ..scrapers.anilist import AniListClient
        client = AniListClient()
        franchise = await client.get_franchise_entries(anime_name)
        
        if franchise:
            # Collapse season variants (e.g., "Side Story Part 2/3" → deduplicated)
            titles = [e['title'] for e in franchise]
            collapsed = _collapse_season_variants(titles)
            
            # Filter franchise to only keep entries whose titles survived collapse
            collapsed_set = set(collapsed)
            franchise = [e for e in franchise if e['title'] in collapsed_set]
            
            if len(franchise) > 1:
                result['needs_disambiguation'] = True
                result['options'] = [
                    {'name': entry['title'], 'id': entry['id'], 'relation_type': entry['relation']}
                    for entry in franchise
                ]
                result['source'] = 'anilist'
                titles = [e['title'] for e in franchise]
                logger.info(f"AniList found {len(franchise)} distinct entries: {titles}")
                return result
            else:
                logger.info(f"AniList entries collapsed to 1, no disambiguation needed")
                return result
        else:
            logger.warning(f"AniList: single continuity or not found, no disambiguation needed")
            return result
    except Exception as e:
        logger.error(f"AniList franchise check failed: {e}")
    
    # Step 2: Fallback to LLM web search (for obscure titles not on AniList)
    logger.info(f"Falling back to web search for '{anime_name}'...")
    franchise_entries = await _search_franchise_entries(anime_name)
    
    # Apply season dedup to LLM results
    franchise_entries = _collapse_season_variants(franchise_entries)
    
    if franchise_entries and len(franchise_entries) > 1:
        result['needs_disambiguation'] = True
        result['options'] = [
            {'name': entry, 'id': None, 'relation_type': 'unknown'}
            for entry in franchise_entries
        ]
        result['source'] = 'web_search'
        logger.info(f"Web search found {len(franchise_entries)} entries: {franchise_entries[:5]}")
        return result
    else:
        logger.info(f"Single entry or standalone series, no disambiguation needed")
    
    return result


def _collapse_season_variants(entries: List[str]) -> List[str]:
    """
    Post-processing filter to collapse season variants into their parent title.
    
    Catches patterns like:
      "Solo Leveling Season 2: Arise from Shadow" → collapsed into "Solo Leveling"
      "Mushoku Tensei Part 2" → collapsed into "Mushoku Tensei"
      "Vinland Saga 2nd Season" → collapsed into "Vinland Saga"
    
    Keeps genuinely distinct entries like:
      "Naruto: Shippuden" (different name, not "Naruto Season 2")
      "Boruto: Naruto Next Generations" (different continuity)
    """
    import re
    
    if not entries or len(entries) <= 1:
        return entries
    
    # Season markers: patterns that indicate "same show, different season"
    SEASON_PATTERNS = re.compile(
        r'\s*(?:'
        r'Season\s+\d+'           # "Season 2", "Season 3"
        r'|S\d+'                  # "S2", "S3"
        r'|\d+(?:st|nd|rd|th)\s+Season'  # "2nd Season", "3rd Season"
        r'|Part\s+\d+'            # "Part 2", "Part 3"
        r'|Cour\s+\d+'            # "Cour 2"
        r'|(?:Part|Season)\s+(?:One|Two|Three|Four|Five)'  # "Part Two"
        r')'
        r'(?:\s*[:：\-–—]\s*.+)?$',   # Optional subtitle after season marker
        re.IGNORECASE
    )
    
    # For each entry, check if removing a season marker makes it a substring of another entry
    # Group entries by their "base title" (title with season marker stripped)
    base_titles: Dict[str, str] = {}  # normalized base → original entry
    
    for entry in entries:
        # Try stripping season patterns
        base = SEASON_PATTERNS.sub('', entry).strip()
        base_norm = base.lower().strip(' :：-–—')
        
        if base_norm not in base_titles:
            base_titles[base_norm] = entry
        else:
            # Keep the shorter/simpler title (the parent)
            existing = base_titles[base_norm]
            if len(entry) < len(existing):
                base_titles[base_norm] = entry
    
    result = list(dict.fromkeys(base_titles.values()))  # Deduplicate while preserving order
    
    if len(result) < len(entries):
        removed = set(entries) - set(result)
        logger.info(f"Collapsed season variants: removed {removed}")
    
    return result


async def _search_franchise_entries(anime_name: str) -> List[str]:
    """
    Use web search to find all entries in an anime franchise.
    
    This is the FALLBACK path — only used when AniList doesn't find the title.
    Works across all 3 providers that support search (Google, OpenAI, Anthropic).
    
    Args:
        anime_name: Name of the anime to search for
        
    Returns:
        List of franchise entries (e.g., ["Fate/stay night", "Fate/Zero", "Fate/Grand Order"])
    """
    from ..llm import get_llm_manager
    from pydantic import BaseModel
    import json
    
    manager = get_llm_manager()
    # Use research agent's provider since it's configured for search
    provider, model = manager.get_provider_for_agent("research")
    logger.info(f"Using provider: {provider.name}, model: {model}")
    
    # Very explicit prompt - LLM tends to add prose with web search
    query = f'''List all anime series in the same franchise as "{anime_name}".

OUTPUT FORMAT: JSON array ONLY. Example:
["Naruto", "Naruto: Shippuden", "Boruto: Naruto Next Generations"]

RULES:
- Official English titles only
- Main series + major sequels/spinoffs
- NO explanations, NO prose, JUST the JSON array

Start your response with [ and end with ]'''
    
    logger.info(f"Web search for '{anime_name}' franchise...")
    
    # Filter out generic labels
    GENERIC_LABELS = {'original series', 'sequel', 'prequel', 'spinoff', 'movie', 
                      'original', 'part 2', 'part 1', 'season 1', 'season 2',
                      'main series', 'side story', 'ova', 'special', 'the movie'}
    
    try:
        if hasattr(provider, 'complete_with_search'):
            response = await provider.complete_with_search(
                messages=[{"role": "user", "content": query}],
                system="Return only a JSON array of anime titles. No explanation.",
                model=model,
                max_tokens=4096,  # Increased to prevent truncation
                temperature=0.2
            )
            
            content = response.content.strip()
            logger.debug(f"RAW RESPONSE LENGTH: {len(content)} chars")
            logger.debug(f"RAW RESPONSE: {content[:300]}...")
            
            
            # Try to find and parse JSON array
            start_idx = content.find('[')
            end_idx = content.rfind(']')
            
            # Handle truncated responses - if we have [ but no ], add it
            if start_idx != -1 and end_idx == -1:
                logger.info(f"Response truncated, attempting fix...")
                content = content + ']'
                end_idx = len(content) - 1
            
            if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
                json_str = content[start_idx:end_idx + 1]
                # Normalize newlines
                json_str = json_str.replace('\n', ' ').replace('\r', ' ')
                logger.info(f"Attempting to parse: {json_str[:100]}...")
                
                try:
                    entries = json.loads(json_str)
                    if isinstance(entries, list):
                        valid_entries = [
                            entry.strip() for entry in entries
                            if isinstance(entry, str) 
                            and entry.strip()
                            and entry.lower().strip() not in GENERIC_LABELS
                        ]
                        logger.info(f"Web search returned: {valid_entries[:10]}...")
                        return valid_entries  # Return all entries, don't limit
                    else:
                        logger.info(f"Parsed but not a list: {type(entries)}")
                except json.JSONDecodeError as e:
                    logger.error(f"JSON parse error: {e}")
                    
                    # Fallback: Use ValidatorAgent to repair
                    try:
                        from .validator import ValidatorAgent
                        
                        # Define a simple schema for the array
                        class FranchiseList(BaseModel):
                            titles: List[str]
                        
                        validator = ValidatorAgent()
                        # Wrap in object for schema compliance
                        repaired = await validator.repair_json(
                            broken_json=f'{{"titles": {json_str}}}',
                            target_schema=FranchiseList,
                            error_msg=str(e)
                        )
                        if repaired and repaired.titles:
                            valid_entries = [
                                t.strip() for t in repaired.titles
                                if t.strip() and t.lower().strip() not in GENERIC_LABELS
                            ]
                            logger.info(f"Validator repair returned: {valid_entries[:10]}...")
                            return valid_entries  # Return all, don't limit
                    except Exception as repair_error:
                        logger.error(f"Validator repair failed: {repair_error}")
            
            logger.warning(f"Could not parse JSON from response: {content[:200]}")
            return [anime_name]
        else:
            logger.info(f"Provider {provider.name} doesn't support search")
            return [anime_name]
            
    except Exception as e:
        logger.error(f"Web search failed: {e}")
        return [anime_name]


async def research_and_apply_profile(
    session: Session, 
    anime_name: str,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Research an anime and apply the profile to the session.
    
    This is triggered during Phase 0 (Media Detection) when the player
    mentions an anime/manga they want to use as inspiration.
    
    Priority:
    1. Web search (mandatory if available)
    2. Existing V2 profile (enhancement)
    3. Training data (fallback only)
    
    Args:
        session: Current session state
        anime_name: Name of the anime mentioned
        progress_tracker: Optional tracker for streaming progress updates
        
    Returns:
        Research summary dict with key info
    """
    from .profile_generator import generate_and_save_profile, load_existing_profile
    
    # First check if profile already exists
    existing = load_existing_profile(anime_name)
    if existing:
        # We have a v3 compact profile - use it directly
        session.character_draft.narrative_profile = existing.get("id")
        session.character_draft.media_reference = anime_name
        session.phase_state["profile_data"] = existing
        return {
            "status": "existing_profile",
            "profile_id": existing.get("id"),
            "confidence": existing.get("confidence", 100),
            "dna_scales": existing.get("dna_scales", {}),
            "combat_style": existing.get("combat_system", "tactical")
        }
    
    # Research the anime AND save to disk + index to RAG
    logger.info(f"Researching and saving profile for: {anime_name}")
    profile = await generate_and_save_profile(anime_name, progress_tracker=progress_tracker)
    
    # Apply to session
    session.character_draft.media_reference = anime_name
    session.character_draft.narrative_profile = profile.get("id")
    session.phase_state["profile_data"] = profile
    session.phase_state["research_output"] = {
        "title": profile.get("name"),
        "confidence": profile.get("confidence"),
        "research_method": profile.get("research_method"),
        "sources_consulted": profile.get("sources_consulted", [])
    }
    
    # EARLY SETTINGS SYNC: Update settings immediately after research completes
    # Prevents wrong profile loading if server restarts before handoff
    try:
        from src.settings import get_settings_store
        settings_store = get_settings_store()
        current_settings = settings_store.load()
        profile_id = profile.get("id")
        if current_settings.active_profile_id != profile_id:
            logger.info(f"Early sync after research: {current_settings.active_profile_id} -> {profile_id}")
            current_settings.active_profile_id = profile_id
            current_settings.active_session_id = session.session_id
            settings_store.save(current_settings)
    except Exception as sync_err:
        logger.error(f"Early sync failed (non-fatal): {sync_err}")
    
    return {
        "status": "researched",
        "profile_id": profile.get("id"),
        "confidence": profile.get("confidence"),
        "research_method": profile.get("research_method"),
        "dna_scales": profile.get("dna_scales", {}),
        "combat_style": profile.get("combat_system", "tactical"),
        "power_system": profile.get("power_system"),
        "sources": profile.get("sources_consulted", [])
    }


def get_profile_context_for_agent(session: Session) -> str:
    """
    Get profile context to inject into agent prompts.
    
    Extracts key information from the researched/loaded profile
    for use in subsequent Session Zero phases.
    """
    profile_data = session.phase_state.get("profile_data", {})
    
    if not profile_data:
        return "(No profile loaded yet)"
    
    parts = [f"# Loaded Profile: {profile_data.get('name', 'Unknown')}"]
    
    # DNA scales
    if dna := profile_data.get("dna_scales", {}):
        parts.append("\n## Narrative DNA:")
        for scale, value in dna.items():
            parts.append(f"  - {scale}: {value}/10")
    
    # Combat style
    if combat := profile_data.get("combat_system"):
        parts.append(f"\n## Combat Style: {combat}")
    
    # Power system
    if power := profile_data.get("power_system"):
        if isinstance(power, dict):
            parts.append(f"\n## Power System: {power.get('name', 'Unknown')}")
            if mechanics := power.get("mechanics"):
                parts.append(f"   Mechanics: {mechanics}")
    
    # Director personality
    if personality := profile_data.get("director_personality"):
        parts.append(f"\n## Director Voice:\n{personality}")
    
    return "\n".join(parts)


async def generate_custom_profile(session: Session) -> Dict[str, Any]:
    """
    Generate a custom (original) world profile for the session.
    
    Called when player says "Original" instead of an anime reference.
    Creates a basic fantasy world profile, saves it to session-scoped storage,
    and indexes it for RAG retrieval.
    
    Args:
        session: Current session state
        
    Returns:
        Dict with creation status
    """
    from datetime import datetime
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    
    # Create a default custom world profile
    # In a future enhancement, we could use an AI agent to generate this
    world_data = {
        "id": f"custom_{session_id[:8]}",
        "name": "Original Fantasy World",
        "profile_type": "custom",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        
        # Default DNA scales for balanced fantasy
        "dna_scales": {
            "introspection_vs_action": 5,
            "comedy_vs_drama": 5,
            "tactical_vs_instinctive": 5,
            "grounded_vs_absurd": 4,
            "power_fantasy_vs_struggle": 5,
            "fast_vs_slow": 5,
            "episodic_vs_serial": 6,
            "ensemble_vs_solo": 5,
            "mystery_vs_transparent": 5,
            "dark_vs_hopeful": 5,
            "romance_weight": 3
        },
        
        "combat_system": "tactical_fantasy",
        "power_system": {
            "name": "Flexible Magic & Skills",
            "mechanics": "Character-defined abilities with creative freedom"
        },
        "tone": "Balanced fantasy adventure with room for exploration"
    }
    
    # Generate some starter lore for RAG
    lore_content = f"""
# Custom Fantasy World

This is an original fantasy world created for this campaign.

## World Foundation
A realm where magic and adventure await. The world is malleable, 
shaped by the player's choices and the unfolding narrative.

## Magic System
Magic is flexible and character-driven. Each protagonist discovers 
their own unique abilities through the story.

## Tone
Balanced between light and dark moments. Adventure is the core theme,
with room for humor, drama, and personal growth.

## Campaign Notes
- Created: {datetime.now().strftime('%Y-%m-%d')}
- Session: {session_id[:8]}
- Type: Original/Custom World

The world will be developed collaboratively during play.
"""
    
    # Save to disk
    save_custom_profile(session_id, world_data, lore_content)
    
    # Index lore into custom ChromaDB
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="generated")
    
    # Apply to session
    session.character_draft.media_reference = "Original"
    session.character_draft.narrative_profile = world_data["id"]
    session.phase_state["profile_data"] = world_data
    session.phase_state["profile_type"] = "custom"
    
    logger.info(f"Created custom profile for session {session_id[:8]}, indexed {chunks_indexed} lore chunks")
    
    return {
        "status": "custom_profile_created",
        "profile_id": world_data["id"],
        "session_id": session_id,
        "chunks_indexed": chunks_indexed
    }


async def research_hybrid_profile(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    blend_ratio: float = 0.6,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Research two anime series and merge them into a hybrid profile.
    
    This is triggered when a player mentions blending two anime
    (e.g., "I want Death Note meets Code Geass").
    
    Flow:
    1. Research both anime in parallel
    2. Merge using ProfileMergeAgent
    3. Save to session-scoped storage
    
    Args:
        session: Current session state
        primary_anime: Primary anime to research (gets blend_ratio weight)
        secondary_anime: Secondary anime to blend in
        blend_ratio: Weight for primary (0.6 = 60% primary, 40% secondary)
        progress_tracker: Optional tracker for streaming progress updates
        
    Returns:
        Dict with hybrid profile info
    """
    import asyncio
    from .anime_research import research_anime_with_search
    from .profile_merge import ProfileMergeAgent
    from .progress import ProgressPhase
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    
    # Emit start
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Starting hybrid research: {primary_anime} × {secondary_anime}",
            5
        )
    
    # ========== STEP 1: Parallel Research ==========
    logger.info(f"Hybrid research: {primary_anime} + {secondary_anime}")
    
    # Research both in parallel (no individual progress trackers to avoid conflicts)
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.RESEARCH,
            f"Researching {primary_anime}...",
            10
        )
    
    try:
        # Use asyncio.gather for parallel execution
        research_a, research_b = await asyncio.gather(
            research_anime_with_search(primary_anime),
            research_anime_with_search(secondary_anime)
        )
    except Exception as e:
        logger.error(f"Hybrid research failed: {e}")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.ERROR,
                f"Research failed: {str(e)}",
                100
            )
        raise
    
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.RESEARCH,
            f"Research complete. Blending profiles...",
            80
        )
    
    # ========== STEP 2: Merge Profiles ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            f"Merging {primary_anime} with {secondary_anime}...",
            85
        )
    
    merge_agent = ProfileMergeAgent()
    merged = await merge_agent.merge(
        profile_a=research_a,
        profile_b=research_b,
        blend_ratio=blend_ratio,
        primary_name=primary_anime,
        secondary_name=secondary_anime
    )
    
    # ========== STEP 3: Save to Session Storage ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Saving hybrid profile...",
            92
        )
    
    # Build profile data from merged output
    hybrid_id = f"hybrid_{session_id[:8]}"
    from datetime import datetime
    
    profile_data = {
        "id": hybrid_id,
        "name": merged.title,
        "profile_type": "hybrid",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        "primary_source": primary_anime,
        "secondary_source": secondary_anime,
        "blend_ratio": blend_ratio,
        
        "dna_scales": merged.dna_scales,
        "combat_system": merged.combat_style,
        "power_system": merged.power_system,
        "tone": merged.tone,
        "storytelling_tropes": merged.storytelling_tropes,
        "world_setting": merged.world_setting,
        
        "confidence": merged.confidence,
        "research_method": "hybrid_merge"
    }
    
    # Build lore content for RAG
    lore_content = merged.raw_content or f"""
# Hybrid Profile: {merged.title}

This is a hybrid world blending {primary_anime} ({blend_ratio*100:.0f}%) with {secondary_anime} ({(1-blend_ratio)*100:.0f}%).

## Power System
{merged.power_system}

## Combat Style
{merged.combat_style}

## Tone
{merged.tone}
"""
    
    # Save to disk
    save_custom_profile(session_id, profile_data, lore_content)
    
    # Store in LoreStore SQL
    from ..scrapers.lore_store import get_lore_store
    lore_store = get_lore_store()
    hybrid_profile_id = f"hybrid_{session_id[:12]}"
    lore_store.store_pages(hybrid_profile_id, [{
        "title": merged.title or f"{primary_anime} × {secondary_anime}",
        "page_type": "hybrid",
        "content": lore_content,
    }])
    
    # Index into RAG
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="hybrid_research")
    
    # Apply to session
    session.character_draft.media_reference = f"{primary_anime} × {secondary_anime}"
    session.character_draft.narrative_profile = hybrid_id
    session.phase_state["profile_data"] = profile_data
    session.phase_state["profile_type"] = "hybrid"
    session.phase_state["blend_sources"] = [primary_anime, secondary_anime]
    
    # Emit completion
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            f"Hybrid profile complete! Confidence: {merged.confidence}%",
            100,
            {"confidence": merged.confidence, "title": merged.title}
        )
    
    logger.info(f"Hybrid profile created: {merged.title} (confidence: {merged.confidence}%)")
    
    return {
        "status": "hybrid_profile_created",
        "profile_id": hybrid_id,
        "title": merged.title,
        "primary": primary_anime,
        "secondary": secondary_anime,
        "blend_ratio": blend_ratio,
        "confidence": merged.confidence,
        "chunks_indexed": chunks_indexed
    }


async def research_hybrid_profile_cached(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    user_preferences: Optional[Dict[str, Any]] = None,
    blend_ratio: float = 0.6,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Token-efficient hybrid: loads existing profiles, only researches missing ones.
    
    Flow:
    1. Check if each base profile exists on disk
    2. Research only missing profiles (saved permanently as base profiles)
    3. Synthesize hybrid (session-scoped only)
    
    This is much more token-efficient for repeated hybrids:
    - First "A × B" researches both, saves both permanently
    - Second "A × C" only researches C (A is cached)
    - Third "B × C" costs almost nothing (both cached)
    
    Args:
        session: Current session state
        primary_anime: Primary anime
        secondary_anime: Secondary anime  
        user_preferences: Dict with "power_system" choice ("primary", "secondary", "synthesized", "coexist")
        blend_ratio: Weight for primary (0.6 = 60% primary)
        progress_tracker: Optional tracker for SSE streaming
        
    Returns:
        Dict with hybrid profile info
    """
    from .profile_generator import load_existing_profile, generate_and_save_profile
    from .profile_merge import ProfileMergeAgent
    from .progress import ProgressPhase
    from .anime_research import AnimeResearchOutput
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    user_preferences = user_preferences or {}
    
    # Emit start
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Hybrid research: {primary_anime} × {secondary_anime}",
            5
        )
    
    # ========== STEP 1: Load/Research Primary Profile ==========
    profile_a = load_existing_profile(primary_anime)
    research_a = None
    
    if profile_a:
        logger.info(f"Loaded cached profile for '{primary_anime}'")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {primary_anime} (cached)",
                20
            )
    else:
        logger.info(f"Researching '{primary_anime}' (not cached)")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"Researching {primary_anime}...",
                10
            )
        # Research and save permanently
        profile_a = await generate_and_save_profile(primary_anime, progress_tracker=None)
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {primary_anime} (researched & cached)",
                40
            )
    
    # ========== STEP 2: Load/Research Secondary Profile ==========
    profile_b = load_existing_profile(secondary_anime)
    
    if profile_b:
        logger.info(f"Loaded cached profile for '{secondary_anime}'")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {secondary_anime} (cached)",
                60
            )
    else:
        logger.info(f"Researching '{secondary_anime}' (not cached)")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"Researching {secondary_anime}...",
                45
            )
        profile_b = await generate_and_save_profile(secondary_anime, progress_tracker=None)
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {secondary_anime} (researched & cached)",
                70
            )
    
    # ========== STEP 3: Convert profiles to AnimeResearchOutput for merge ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Synthesizing hybrid world...",
            80
        )
    
    # Build research outputs from loaded profiles
    def profile_to_research(profile: Dict) -> AnimeResearchOutput:
        """Convert stored profile dict to AnimeResearchOutput for merge."""
        return AnimeResearchOutput(
            title=profile.get("name", profile.get("id", "Unknown")),
            media_type=profile.get("media_type", "anime"),
            dna_scales=profile.get("dna_scales", {}),
            power_system=profile.get("power_system", {}),
            combat_style=profile.get("combat_system", profile.get("combat_style", "spectacle")),
            tone=profile.get("tone", {}),
            storytelling_tropes=profile.get("tropes", profile.get("storytelling_tropes", {})),
            world_setting=profile.get("world_setting", {}),
            confidence=profile.get("confidence", 90),
            research_method="cached_profile"
        )
    
    research_a = profile_to_research(profile_a)
    research_b = profile_to_research(profile_b)
    
    # ========== STEP 4: Merge with user preferences ==========
    merge_agent = ProfileMergeAgent()
    merged = await merge_agent.merge(
        profile_a=research_a,
        profile_b=research_b,
        blend_ratio=blend_ratio,
        primary_name=primary_anime,
        secondary_name=secondary_anime
    )
    
    # ========== STEP 5: Save to Session Storage (NOT permanent) ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Saving hybrid profile...",
            92
        )
    
    hybrid_id = f"hybrid_{session_id[:8]}"
    from datetime import datetime
    
    profile_data = {
        "id": hybrid_id,
        "name": merged.title,
        "profile_type": "hybrid",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        "primary_source": primary_anime,
        "secondary_source": secondary_anime,
        "blend_ratio": blend_ratio,
        "user_preferences": user_preferences,
        
        "dna_scales": merged.dna_scales,
        "combat_system": merged.combat_style,
        "power_system": merged.power_system,
        "tone": merged.tone,
        "storytelling_tropes": merged.storytelling_tropes,
        "world_setting": merged.world_setting,
        
        "confidence": merged.confidence,
        "research_method": "cached_hybrid_merge"
    }
    
    lore_content = merged.raw_content or f"""
# Hybrid Profile: {merged.title}

Blending {primary_anime} ({blend_ratio*100:.0f}%) with {secondary_anime} ({(1-blend_ratio)*100:.0f}%).
Power system preference: {user_preferences.get('power_system', 'coexist')}

## Power System
{merged.power_system}

## Combat Style
{merged.combat_style}
"""
    
    # Save to session storage
    save_custom_profile(session_id, profile_data, lore_content)
    
    # Store in LoreStore SQL
    from ..scrapers.lore_store import get_lore_store
    lore_store = get_lore_store()
    hybrid_profile_id = f"hybrid_{session_id[:12]}"
    lore_store.store_pages(hybrid_profile_id, [{
        "title": merged.title or f"{primary_anime} × {secondary_anime}",
        "page_type": "hybrid",
        "content": lore_content,
    }])
    
    # Index into RAG
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="cached_hybrid")
    
    # Apply to session
    session.character_draft.media_reference = f"{primary_anime} × {secondary_anime}"
    session.character_draft.narrative_profile = hybrid_id
    session.phase_state["profile_data"] = profile_data
    session.phase_state["profile_type"] = "hybrid"
    session.phase_state["blend_sources"] = [primary_anime, secondary_anime]
    
    # Emit completion
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            f"Hybrid complete! {merged.title}",
            100,
            {"confidence": merged.confidence, "title": merged.title}
        )
    
    logger.info(f"Created: {merged.title} (confidence: {merged.confidence}%)")
    
    return {
        "status": "hybrid_profile_created",
        "profile_id": hybrid_id,
        "title": merged.title,
        "primary": primary_anime,
        "secondary": secondary_anime,
        "blend_ratio": blend_ratio,
        "confidence": merged.confidence,
        "chunks_indexed": chunks_indexed,
        "cached_primary": profile_a is not None,
        "cached_secondary": profile_b is not None
    }


async def ensure_hybrid_prerequisites(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    progress_tracker: Optional["ProgressTracker"] = None
) -> None:
    """
    Ensure base profiles for hybrid synthesis are researched and cached.
    Triggered during Phase 1 (Calibration) to front-load the research latency.
    """
    from .profile_generator import load_existing_profile, generate_and_save_profile
    from .progress import ProgressPhase
    import asyncio
    from typing import Optional
    from ..agents.progress import ProgressTracker
    
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Pre-researching sources: {primary_anime} & {secondary_anime}",
            5
        )

    # 1. Check Cache
    profile_a = load_existing_profile(primary_anime)
    profile_b = load_existing_profile(secondary_anime)
    
    # 2. Queue missing researches
    tasks = []
    
    if not profile_a:
        logger.warning(f"{primary_anime} missing, queuing research...")
        tasks.append(primary_anime)
    else:
        if progress_tracker:
            await progress_tracker.emit(ProgressPhase.RESEARCH, f"✓ {primary_anime} already cached", 20)

    if not profile_b:
        logger.warning(f"{secondary_anime} missing, queuing research...")
        tasks.append(secondary_anime)
    else:
        if progress_tracker:
             await progress_tracker.emit(ProgressPhase.RESEARCH, f"✓ {secondary_anime} already cached", 40)
             
    # 3. Execute Parallel Research
    if tasks:
        from .progress import WeightedProgressGroup
        
        # Weighted Group: Each profile is 50% of the research phase
        active_tasks_count = len(tasks)
        
        if progress_tracker:
            group = WeightedProgressGroup(progress_tracker)
            names = []
            if not profile_a: names.append(primary_anime)
            if not profile_b: names.append(secondary_anime)
            await progress_tracker.emit(ProgressPhase.RESEARCH, f"Researching sources: {', '.join(names)}...", 0)

        # Prepare coroutines
        coroutines = []
        
        # LOGIC:
        # We always treat this as a 50/50 split of the *Progress Bar*.
        # If a profile is missing -> Attach a new tracker (weight 0.5)
        # If a profile is cached -> It effectively contributed 50% instantly.
        # However, to avoid "Instant 50% jump" then "Slow 50->" behavior if only 1 is missing,
        # we should just give the missing one full weight if it's the only one running.
        
        if active_tasks_count == 2:
            # Both running: 50/50 split
            tracker_a = group.create_sub_tracker(weight=0.5, name=primary_anime) if progress_tracker else None
            coroutines.append(generate_and_save_profile(primary_anime, progress_tracker=tracker_a))
            
            tracker_b = group.create_sub_tracker(weight=0.5, name=secondary_anime) if progress_tracker else None
            coroutines.append(generate_and_save_profile(secondary_anime, progress_tracker=tracker_b))
            
        elif active_tasks_count == 1:
            # One running: Give it 100% of the *remaining* focus
            # The cached one is already "done" in user's mind
            missing_name = primary_anime if not profile_a else secondary_anime
            tracker = group.create_sub_tracker(weight=1.0, name=missing_name) if progress_tracker else None
            coroutines.append(generate_and_save_profile(missing_name, progress_tracker=tracker))

        # Run in parallel with exception safety
        results = await asyncio.gather(*coroutines, return_exceptions=True)
        
        # Check for failures
        failed_tasks = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"Task {i} failed: {result}")
                failed_tasks.append(str(result))

        if failed_tasks and progress_tracker:
            error_msg = f"Research failed: {'; '.join(failed_tasks)}"
            await progress_tracker.emit(ProgressPhase.ERROR, error_msg, 100)
            return

    # 5. Complete
    logger.info(f"Base profiles ready for {primary_anime} x {secondary_anime}")
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            "Sources ready. Please confirm blend preferences.",
            100
        )
