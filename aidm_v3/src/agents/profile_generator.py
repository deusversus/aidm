"""
Profile Generator for AIDM v3.

Converts anime research into compact YAML profiles for runtime use.
Follows the format specified in dev/AIDM_V3_PROFILE_GENERATION.md.
"""

import asyncio
import yaml
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime

from .anime_research import AnimeResearchOutput, research_anime_with_search
from .progress import ProgressPhase
from typing import TYPE_CHECKING
import re

if TYPE_CHECKING:
    from .progress import ProgressTracker


def _sanitize_profile_id(name: str) -> str:
    """Sanitize anime name for use as profile ID/filename.
    
    Handles special characters common in anime titles:
    - Fate/Stay Night -> fate_stay_night
    - Re:Zero -> re_zero
    - Steins;Gate -> steins_gate
    - K-On! -> k_on
    
    Also handles absurdly long light novel titles:
    - "I Was Reincarnated as the 7th Prince..." -> "i_was_reincarnated_as_the_7th_prince"
    """
    MAX_PROFILE_ID_LENGTH = 100  # Generous limit for long light novel titles
    
    # Lowercase and replace spaces/common separators with underscore
    result = name.lower().replace(" ", "_")
    # Remove all non-alphanumeric characters except underscore
    result = re.sub(r'[^a-z0-9_]', '', result)
    # Collapse multiple underscores
    result = re.sub(r'_+', '_', result)
    # Remove leading/trailing underscores
    result = result.strip('_')
    
    # Truncate long titles (common with light novels)
    if len(result) > MAX_PROFILE_ID_LENGTH:
        result = result[:MAX_PROFILE_ID_LENGTH]
        # Try to break cleanly on underscore
        last_underscore = result.rfind('_')
        if last_underscore > MAX_PROFILE_ID_LENGTH // 2:  # Don't truncate too much
            result = result[:last_underscore]
    
    return result


def _build_aliases(title: str, alternate_titles: list) -> list:
    """
    Build a list of normalized aliases from title and alternate titles.
    
    Includes:
    - Normalized English title
    - No-space variant (e.g., "dragonball")
    - All provided alternate titles (normalized)
    """
    from ..utils.title_utils import normalize_title
    
    aliases = set()
    
    # Add normalized title
    normalized = normalize_title(title)
    aliases.add(normalized)
    
    # Add no-space variant
    no_space = normalized.replace(" ", "")
    if no_space != normalized:
        aliases.add(no_space)
    
    # Add all alternate titles
    for alt in alternate_titles or []:
        if alt:
            # Keep non-Latin titles as-is (don't normalize CJK characters)
            if any(ord(c) > 127 for c in alt):
                aliases.add(alt)
            else:
                aliases.add(normalize_title(alt))
    
    return sorted(list(aliases))


def generate_compact_profile(research: AnimeResearchOutput) -> Dict[str, Any]:
    """
    Generate a compact YAML-serializable profile from research output.
    
    Args:
        research: AnimeResearchOutput from the research agent
        
    Returns:
        Dictionary ready for YAML serialization
    """
    # Normalize title for ID (sanitize invalid filename characters)
    profile_id = _sanitize_profile_id(research.title)
    
    # Build compact profile
    profile = {
        "id": profile_id,
        "name": research.title,
        "source_anime": research.title,
        "media_type": research.media_type,
        "status": research.status,
        "generated_at": datetime.now().isoformat(),
        "confidence": research.confidence,
        "research_method": research.research_method,
        
        # Aliases for fuzzy matching (from research alternate_titles)
        "aliases": _build_aliases(research.title, research.alternate_titles),
        
        # 11 DNA Scales
        "dna_scales": research.dna_scales,
        
        # Power Distribution (LLM-researched, or inferred as fallback)
        "power_distribution": research.power_distribution if research.power_distribution.get("gradient") != "flat" or research.power_distribution.get("typical_tier") != "T8" else _infer_power_distribution(research),
        # Backward compat: world_tier for any consumers that still read it
        "world_tier": (research.power_distribution or {}).get("typical_tier", "T8"),
        
        # 15 Tropes
        "tropes": research.storytelling_tropes,
        
        # Detected genres (for arc template selection)
        "detected_genres": research.detected_genres or [],
        
        # Combat and progression
        "combat_system": research.combat_style,
        "power_system": research.power_system,
        
        # Tone
        "tone": research.tone,
        
        # Director personality (LLM-synthesized, with deterministic fallback)
        "director_personality": research.director_personality or _generate_director_personality(research),
        
        # Pacing (LLM-synthesized, with deterministic fallback)
        "pacing": _build_pacing(research),
        
        # Sources for transparency
        "sources_consulted": research.sources_consulted,
    }
    
    # Add voice cards for NPC differentiation (if extracted)
    if research.voice_cards:
        profile["voice_cards"] = research.voice_cards
    
    # Add author voice for IP authenticity (if extracted)
    if research.author_voice:
        profile["author_voice"] = research.author_voice
    
    # Add series detection fields
    profile["series_group"] = research.series_group or profile_id
    profile["series_position"] = research.series_position or 1
    
    # Add spinoff/alternate linking
    if research.related_franchise:
        profile["related_franchise"] = research.related_franchise
        profile["relation_type"] = research.relation_type or "spinoff"
    
    # Add recent updates if ongoing (not for finished series)
    if research.recent_updates and research.status and research.status.lower() in ("releasing", "not_yet_released"):
        profile["recent_updates"] = research.recent_updates
    
    return profile


def _generate_director_personality(research: AnimeResearchOutput) -> str:
    """Fallback: generate a basic director personality from DNA scales.
    
    Only used when LLM synthesis (Call 4) fails. The LLM-generated version
    is always preferred because it captures IP-specific thematic nuance.
    """
    dna = research.dna_scales
    traits = []
    
    # Introspection (low value = introspective, high = action)
    if dna.get("introspection_vs_action", 5) <= 3:
        traits.append("You explore character thoughts and feelings deeply.")
    elif dna.get("introspection_vs_action", 5) >= 7:
        traits.append("You favor action and momentum over lengthy contemplation.")
    
    # Comedy vs drama
    if dna.get("comedy_vs_drama", 5) >= 7:
        traits.append("You inject humor even in tense moments.")
    elif dna.get("comedy_vs_drama", 5) <= 3:
        traits.append("You maintain dramatic weight; comedy is rare and earned.")
    
    # Pacing
    if dna.get("fast_paced_vs_slow_burn", 5) >= 7:
        traits.append("You let scenes breathe. Patience is a virtue; payoffs are earned.")
    elif dna.get("fast_paced_vs_slow_burn", 5) <= 3:
        traits.append("You keep the pace relentless. Every scene escalates.")
    
    # Hopeful vs cynical
    if dna.get("hopeful_vs_cynical", 5) >= 7:
        traits.append("Victories are pyrrhic. The world is harsh.")
    elif dna.get("hopeful_vs_cynical", 5) <= 3:
        traits.append("Hope is real in this world. Earned optimism, not naivety.")
    
    # Tactical vs instinctive
    if dna.get("tactical_vs_instinctive", 5) <= 3:
        traits.append("You explain strategies and tactics in detail.")
    elif dna.get("tactical_vs_instinctive", 5) >= 7:
        traits.append("Battles are won by willpower and instinct, not chess moves.")
    
    base = f"You are the director for a {research.title}-style campaign. "
    return base + " ".join(traits)


def _build_pacing(research: AnimeResearchOutput) -> Dict[str, Any]:
    """Build pacing dict from LLM pacing_style with deterministic fallback."""
    # Use LLM-synthesized pacing if available
    style = research.pacing_style or _infer_pacing_style(research)
    
    arc_map = {
        "rapid": "2-4",
        "moderate": "4-6",
        "deliberate": "6-10",
    }
    
    return {
        "scene_length": style,
        "arc_length_sessions": arc_map.get(style, "4-6")
    }


def _infer_pacing_style(research: AnimeResearchOutput) -> str:
    """Fallback: infer pacing from DNA scales."""
    dna = research.dna_scales
    fast_score = dna.get("fast_paced_vs_slow_burn", 5)  # Fixed: was "fast_vs_slow"
    
    if fast_score >= 7:
        return "deliberate"  # High = slow burn
    elif fast_score <= 3:
        return "rapid"       # Low = fast paced
    else:
        return "moderate"


def _infer_power_distribution(research: AnimeResearchOutput) -> Dict[str, str]:
    """
    Infer the power distribution for characters in this anime world.
    
    Uses DNA scales and tone to estimate:
    - T10: Slice of life, grounded human stories (Death Note)
    - T8-9: Street level action (Demon Slayer rookies)
    - T6-7: City/Building level (JJK, mid-tier shonen)
    - T4-5: Planetary/Stellar (Dragon Ball Z)
    - T2-3: Universal+ (Dragon Ball Super)
    """
    dna = research.dna_scales
    tone = research.tone if isinstance(research.tone, dict) else {}
    
    # Key indicators
    power_fantasy = dna.get("power_fantasy_vs_struggle", 5)  # 0=underdog, 10=OP
    grounded_vs_absurd = dna.get("grounded_vs_absurd", 5)    # 0=realistic, 10=ridiculous
    
    # Combine indicators (weighted towards grounded_vs_absurd for tier estimation)
    power_score = (power_fantasy * 0.4) + (grounded_vs_absurd * 0.6)
    
    # Map to typical tier
    if power_score <= 2:
        typical = "T10"
    elif power_score <= 4:
        typical = "T9"
    elif power_score <= 5.5:
        typical = "T8"
    elif power_score <= 7:
        typical = "T7"
    elif power_score <= 8.5:
        typical = "T6"
    elif power_score <= 9.5:
        typical = "T5"
    else:
        typical = "T4"
    
    # Estimate peak (2 tiers above typical) and floor (1 below or T10)
    tier_order = ["T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]
    typical_idx = tier_order.index(typical) if typical in tier_order else 6
    peak_idx = max(0, typical_idx - 2)
    floor_idx = min(len(tier_order) - 1, typical_idx + 1)
    
    return {
        "peak_tier": tier_order[peak_idx],
        "typical_tier": typical,
        "floor_tier": tier_order[floor_idx],
        "gradient": "flat",  # Fallback can't determine gradient reliably
    }


async def _validate_and_update_series_positions(series_group: str, profiles_dir: Path) -> None:
    """
    Validate and update series positions for all profiles in a series_group.
    
    Uses ValidatorAgent to ask LLM for canonical ordering, then updates all profiles.
    """
    from ..profiles.loader import find_profiles_by_series_group
    from .validator import ValidatorAgent
    
    # Get all canonical profiles in this series
    profiles_in_series = find_profiles_by_series_group(series_group)
    
    if len(profiles_in_series) <= 1:
        return  # No ordering needed
    
    # Extract titles
    titles = [p['name'] for p in profiles_in_series]
    
    # Ask validator to order them
    validator = ValidatorAgent()
    order_dict = await validator.validate_series_order(series_group, titles)
    
    if not order_dict:
        return  # Validation failed, keep existing positions
    
    # Update each profile with the correct position
    for profile_info in profiles_in_series:
        profile_name = profile_info['name']
        new_position = order_dict.get(profile_name)
        
        if new_position is None:
            continue
        
        # Load the profile, update position, save
        profile_path = profiles_dir / f"{profile_info['id']}.yaml"
        if profile_path.exists():
            with open(profile_path, 'r', encoding='utf-8') as f:
                profile_data = yaml.safe_load(f)
            
            old_position = profile_data.get('series_position', 999)
            if old_position != new_position:
                profile_data['series_position'] = new_position
                with open(profile_path, 'w', encoding='utf-8') as f:
                    yaml.dump(profile_data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
                print(f"[ProfileGenerator] Updated {profile_name} position: {old_position} → {new_position}")


async def generate_and_save_profile(
    anime_name: str,
    profiles_dir: Optional[Path] = None,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Full pipeline: Research anime → Generate profile → Save YAML.
    
    Args:
        anime_name: Name of the anime to research
        profiles_dir: Where to save the profile (default: src/profiles/)
        progress_tracker: Optional tracker for streaming progress updates
        
    Returns:
        Generated profile dictionary
    """
    # Default profiles directory
    if profiles_dir is None:
        profiles_dir = Path(__file__).parent.parent / "profiles"
    
    MAX_RETRIES = 3
    retry_count = 0
    last_error = None
    
    while retry_count < MAX_RETRIES:
        try:
            # Research the anime
            research = await research_anime_with_search(anime_name, progress_tracker=progress_tracker)
            
            # Generate compact profile
            profile = generate_compact_profile(research)
            
            # GUARDRAIL: Fail fast if research returned insufficient lore
            # This prevents orphaned YAML profiles without RAG grounding
            lore_len = len(research.raw_content or '')
            if lore_len < 200:
                raise ValueError(f"Research returned insufficient lore content (len={lore_len}). Retry needed.")
            
            if lore_len < 500:
                print(f"[ProfileGenerator] WARNING: Lore content is short ({lore_len} chars)")
            
            # --- VALIDATE LORE FIRST (before saving anything) ---
            # This prevents orphaned YAML profiles when validation fails
            print(f"[ProfileGenerator] DEBUG: research.raw_content is {'PRESENT' if research.raw_content else 'MISSING'}")
            
            if research.raw_content:
                # For large content (API-sourced wiki scrape), skip repetition-based
                # corruption checks — they were designed for LLM output where looping
                # is a failure mode, not for multi-page wiki dumps where repetition
                # is natural. Still validate small/medium content (old web-search pipeline).
                content_len = len(research.raw_content)
                if content_len < 10000:
                    # Small content: run full validation (corruption + completeness)
                    from .validator import ValidatorAgent
                    print(f"[ProfileGenerator] Validating research (len={content_len})...", flush=True)
                    validator = ValidatorAgent()
                    validation = await validator.validate_research(research.raw_content)
                    print(f"[ProfileGenerator] Validation complete. Is Valid: {validation.is_valid}", flush=True)
                    
                    if validation.has_corruption:
                        raise ValueError(f"Profile lore corrupted: {validation.corruption_type}. Retry needed.")
                    
                    if not validation.is_valid:
                        print(f"[ProfileGenerator] Warning: Lore validation issues: {validation.issues}")
                else:
                    # Large content (wiki scrape): skip repetition checks, only check
                    # for leaked reasoning markers which are always invalid
                    from .validator import ValidatorAgent
                    print(f"[ProfileGenerator] Large content ({content_len} chars) — skipping repetition checks, checking for leaked reasoning only...", flush=True)
                    validator = ValidatorAgent()
                    _, corruption_type, _ = validator._detect_corruption(research.raw_content[:2000])
                    if corruption_type == "leaked_reasoning":
                        raise ValueError(f"Profile lore corrupted: {corruption_type}. Retry needed.")
                    print(f"[ProfileGenerator] Large content validation passed.", flush=True)
            else:
                raise ValueError("Research returned no raw_content. Retry needed.")
            
            # --- ALL VALIDATION PASSED - NOW SAVE ATOMICALLY ---
            
            # 1. Save lore text first (for inspection/backup)
            lore_path = profiles_dir / f"{profile['id']}_lore.txt"
            with open(lore_path, 'w', encoding='utf-8') as f:
                f.write(research.raw_content)
            
            # 2. Ingest into ProfileLibrary (ChromaDB)
            from ..context.profile_library import get_profile_library
            library = get_profile_library()
            library.add_profile_lore(profile['id'], research.raw_content, source="auto_research")
            print(f"[ProfileGenerator] Ingested lore for {profile['id']} into RAG.")
            
            # 3. Save to YAML LAST (after lore is successfully saved)
            profile_path = profiles_dir / f"{profile['id']}.yaml"
            with open(profile_path, 'w', encoding='utf-8') as f:
                yaml.dump(profile, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
            
            print(f"[ProfileGenerator] Saved profile {profile['id']}.yaml with lore")
            
            # --- SERIES ORDER VALIDATION ---
            # If profile has a series_group, validate and update positions for all profiles in the series
            series_group = profile.get('series_group')
            if series_group:
                await _validate_and_update_series_positions(series_group, profiles_dir)
            
            return profile
            
        except Exception as e:
            retry_count += 1
            last_error = e
            print(f"[ProfileGenerator] Error generating '{anime_name}' (Attempt {retry_count}/{MAX_RETRIES}): {e}")
            
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.RESEARCH, 
                    f"Retry {retry_count}: encountered error, restarting...", 
                    0,
                    {"error": str(e)}
                )
            
            # Simple backoff
            await asyncio.sleep(2)
            
    # If we get here, all retries failed
    raise RuntimeError(f"Failed to generate profile for '{anime_name}' after {MAX_RETRIES} attempts. Last error: {last_error}")


def load_existing_profile(anime_name: str) -> Optional[Dict[str, Any]]:
    """
    Check if a profile already exists for this anime.
    
    Uses fuzzy matching via the alias index to handle:
    - Common misspellings (e.g., "Dragonball" -> "Dragon Ball")
    - Title variations (e.g., "Frieren" finds "Frieren: Beyond Journey's End")
    - Abbreviations (e.g., "HxH" -> "Hunter x Hunter")
    
    Args:
        anime_name: Name of the anime (user input)
        
    Returns:
        Profile dict if found, None otherwise
    """
    from ..profiles.loader import find_profile_by_title, reload_alias_index
    
    # Try fuzzy matching via alias index
    match_result = find_profile_by_title(anime_name, fuzzy_threshold=2)
    
    if match_result:
        profile_id, match_type = match_result
        v3_profiles = Path(__file__).parent.parent / "profiles"
        profile_path = v3_profiles / f"{profile_id}.yaml"
        
        if profile_path.exists():
            with open(profile_path, 'r', encoding='utf-8') as f:
                profile = yaml.safe_load(f)
            
            if match_type == "fuzzy":
                print(f"[Profile] Fuzzy matched '{anime_name}' to profile '{profile_id}'")
            
            return profile
    
    # Fallback: Direct filename lookup (for backwards compatibility)
    normalized = _sanitize_profile_id(anime_name)
    normalized_no_space = anime_name.lower().replace(" ", "").replace(":", "").replace("-", "")
    
    v3_profiles = Path(__file__).parent.parent / "profiles"
    for name in [f"{normalized}.yaml", f"{normalized_no_space}.yaml"]:
        path = v3_profiles / name
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                profile = yaml.safe_load(f)
            # Rebuild index since we found a profile not in index
            reload_alias_index()
            return profile
    
    return None


def load_profile_with_disambiguation(anime_name: str) -> Dict[str, Any]:
    """
    Load a profile with series disambiguation support.
    
    If the matched profile is part of a series with multiple entries,
    returns disambiguation options instead of auto-selecting.
    
    Args:
        anime_name: Name of the anime (user input)
        
    Returns:
        Dict with:
        - 'profile': Profile dict if found (or None)
        - 'disambiguation': List of related profiles if series has siblings (or None)
        - 'needs_choice': True if user should choose from disambiguation options
    """
    from ..profiles.loader import find_profile_by_title, get_series_disambiguation
    
    result = {
        'profile': None,
        'disambiguation': None,
        'needs_choice': False
    }
    
    # Try to find profile
    match_result = find_profile_by_title(anime_name, fuzzy_threshold=2)
    
    if not match_result:
        return result
    
    profile_id, match_type = match_result
    v3_profiles = Path(__file__).parent.parent / "profiles"
    profile_path = v3_profiles / f"{profile_id}.yaml"
    
    if not profile_path.exists():
        return result
    
    with open(profile_path, 'r', encoding='utf-8') as f:
        profile = yaml.safe_load(f)
    
    result['profile'] = profile
    
    # Check for series siblings
    disambiguation = get_series_disambiguation(profile_id)
    if disambiguation and len(disambiguation) > 1:
        result['disambiguation'] = disambiguation
        result['needs_choice'] = True
        print(f"[Profile] '{anime_name}' matched '{profile_id}' which has {len(disambiguation)} series entries")
    
    return result


def list_available_profiles() -> Dict[str, str]:
    """
    List all available profiles (v3 compact only).
    
    Returns:
        Dict mapping profile_id to source ("v3")
    """
    profiles = {}
    
    # V3 profiles
    v3_profiles = Path(__file__).parent.parent / "profiles"
    if v3_profiles.exists():
        for f in v3_profiles.glob("*.yaml"):
            if f.stem != "__init__":
                profiles[f.stem] = "v3"
    
    return profiles
