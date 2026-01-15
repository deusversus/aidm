"""Narrative profile loader with fuzzy title matching."""

from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Tuple
from pathlib import Path
import yaml

from ..utils.title_utils import (
    normalize_title, 
    find_closest_match, 
    generate_aliases,
    tokenize_title,
    jaccard_similarity,
    token_subset_match,
    normalized_levenshtein
)


@dataclass
class NarrativeProfile:
    """A narrative profile defines the style and tone for a campaign."""
    
    id: str
    name: str
    source: str
    
    # DNA scales (0-10 each)
    dna: Dict[str, int] = field(default_factory=dict)
    
    # Tropes (on/off)
    tropes: Dict[str, bool] = field(default_factory=dict)
    
    # Combat system
    combat_system: str = "tactical"
    
    # Power system
    power_system: Optional[Dict[str, Any]] = None
    
    # Progression
    progression: Optional[Dict[str, Any]] = None
    
    # Voice guidance for Key Animator
    voice: Optional[str] = None
    
    # Director personality (Showrunner)
    director_personality: Optional[str] = None
    
    # Tone settings (darkness, comedy, optimism)
    tone: Optional[Dict[str, int]] = None
    
    # Series detection for disambiguation and lore sharing
    series_group: Optional[str] = None
    series_position: Optional[int] = None
    series_parent: Optional[str] = None  # Inherit lore from this profile
    
    # Full profile path for deep lookup
    full_profile_path: Optional[str] = None
    
    @property
    def combat_style(self) -> str:
        """Alias for combat_system (some code uses combat_style)."""
        return self.combat_system


def load_profile(profile_id: str, fallback: bool = True) -> NarrativeProfile:
    """Load a narrative profile by ID.
    
    Args:
        profile_id: The profile identifier (e.g., "hunterxhunter")
        fallback: If True, return fallback profile when requested doesn't exist
        
    Returns:
        NarrativeProfile object
        
    Raises:
        FileNotFoundError: If profile YAML doesn't exist and fallback is False
        ValueError: If profile YAML is invalid
    """
    # Look for profile in profiles directory
    profiles_dir = Path(__file__).parent
    profile_path = profiles_dir / f"{profile_id}.yaml"
    
    if not profile_path.exists():
        if fallback:
            # Try to find ANY profile as fallback
            available = list_profiles()
            if available:
                fallback_id = available[0]
                print(f"[Profile] '{profile_id}' not found, falling back to '{fallback_id}'")
                profile_path = profiles_dir / f"{fallback_id}.yaml"
                profile_id = fallback_id
            else:
                # Create minimal default profile
                print(f"[Profile] No profiles available, creating default")
                return NarrativeProfile(
                    id="default",
                    name="Default Campaign",
                    source="System Default",
                    dna={"action": 5, "drama": 5, "comedy": 5},
                    tropes={},
                    combat_system="tactical"
                )
        else:
            raise FileNotFoundError(f"Profile not found: {profile_path}")
    
    with open(profile_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    
    if not data:
        raise ValueError(f"Empty profile: {profile_path}")
    
    return NarrativeProfile(
        id=data.get('id', profile_id),
        name=data.get('name', profile_id.title()),
        source=data.get('source', 'Unknown'),
        dna=data.get('dna') or data.get('dna_scales', {}),
        tropes=data.get('tropes', {}),
        combat_system=data.get('combat_system') or data.get('combat', {}).get('system', 'tactical'),
        power_system=data.get('power_system'),
        progression=data.get('progression'),
        voice=data.get('voice'),
        director_personality=data.get('director_personality'),
        tone=data.get('tone'),
        series_group=data.get('series_group'),
        series_position=data.get('series_position'),
        series_parent=data.get('series_parent'),
        full_profile_path=str(profile_path)
    )


def list_profiles() -> List[str]:
    """List available profile IDs.
    
    Returns:
        List of profile IDs
    """
    profiles_dir = Path(__file__).parent
    profiles = []
    
    for f in profiles_dir.glob("*.yaml"):
        profiles.append(f.stem)
    
    return profiles


# ============================================================================
# ALIAS INDEX - Fuzzy Title Matching
# ============================================================================

# Global alias index: normalized_alias -> profile_id
_ALIAS_INDEX: Dict[str, str] = {}
_INDEX_BUILT = False


def _build_alias_index() -> None:
    """
    Build the alias index from all profile YAML files.
    
    Scans each profile for:
    1. The 'aliases' field (if present)
    2. Generated aliases from the profile name
    3. The normalized profile ID itself
    """
    global _ALIAS_INDEX, _INDEX_BUILT
    
    if _INDEX_BUILT:
        return
    
    profiles_dir = Path(__file__).parent
    
    for profile_path in profiles_dir.glob("*.yaml"):
        try:
            with open(profile_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            
            if not data:
                continue
            
            profile_id = data.get('id', profile_path.stem)
            profile_name = data.get('name', profile_id)
            
            # Add explicit aliases from profile
            explicit_aliases = data.get('aliases', [])
            for alias in explicit_aliases:
                normalized = normalize_title(alias)
                if normalized:
                    _ALIAS_INDEX[normalized] = profile_id
            
            # Generate aliases if none provided
            if not explicit_aliases:
                generated = generate_aliases(profile_name)
                for alias in generated:
                    if alias:
                        _ALIAS_INDEX[alias] = profile_id
            
            # Always add the profile ID itself (normalized)
            _ALIAS_INDEX[normalize_title(profile_id)] = profile_id
            _ALIAS_INDEX[normalize_title(profile_name)] = profile_id
            
        except Exception as e:
            print(f"[AliasIndex] Error loading {profile_path}: {e}")
    
    _INDEX_BUILT = True
    print(f"[AliasIndex] Built index with {len(_ALIAS_INDEX)} aliases for {len(list_profiles())} profiles")


def get_alias_index() -> Dict[str, str]:
    """Get the alias index, building it if necessary."""
    if not _INDEX_BUILT:
        _build_alias_index()
    return _ALIAS_INDEX


def find_profile_by_title(
    title: str,
    fuzzy_threshold: int = 2
) -> Optional[Tuple[str, str]]:
    """
    Find a profile by title, using multi-stage matching.
    
    Match stages (in order of priority):
    1. Exact match - normalized query matches an alias exactly
    2. Containment match - query contains alias OR alias contains query
       This handles "Demon Slayer: Kimetsu no Yaiba" matching "kimetsu no yaiba"
    3. Fuzzy match - Levenshtein distance within threshold
    
    Args:
        title: The anime title to search for
        fuzzy_threshold: Max Levenshtein distance for fuzzy match (0 = exact only)
        
    Returns:
        Tuple of (profile_id, match_type) or None
        match_type is one of: "exact", "contains", "fuzzy"
    """
    if not title:
        return None
    
    index = get_alias_index()
    normalized = normalize_title(title)
    
    # Stage 1: Exact match in alias index
    if normalized in index:
        return (index[normalized], "exact")
    
    # Stage 2: Token-based matching (replaces fragile substring containment)
    # Uses word-level matching instead of character-level to prevent false positives
    # e.g., "re" in "arifureta" won't match because they're different words
    query_tokens = tokenize_title(title)
    best_token_match = None
    best_similarity = 0.0
    
    for alias, profile_id in index.items():
        alias_tokens = tokenize_title(alias)
        
        # Skip empty token sets
        if not alias_tokens or not query_tokens:
            continue
        
        # Check if alias tokens are a subset of query tokens
        # e.g., {"dragon", "ball"} ⊆ {"dragon", "ball", "z"}
        if token_subset_match(alias_tokens, query_tokens):
            # Calculate similarity via Jaccard to prefer better matches
            similarity = jaccard_similarity(alias_tokens, query_tokens)
            
            # When alias is complete subset, require only 30% overlap
            # e.g., "demon slayer" (2 words) in "demon slayer mugen train movie" (5 words) = 40%
            if similarity >= 0.3 and similarity > best_similarity:
                best_token_match = (profile_id, alias, similarity)
                best_similarity = similarity
        
        # Also check reverse: query tokens subset of alias tokens
        # e.g., {"frieren"} ⊆ {"frieren", "beyond", "journeys", "end"}
        elif token_subset_match(query_tokens, alias_tokens, min_alias_tokens=1):
            # Calculate how much of the alias is covered
            similarity = jaccard_similarity(query_tokens, alias_tokens)
            
            # Stricter threshold for reverse matching (80%+)
            if similarity >= 0.8 and similarity > best_similarity:
                best_token_match = (profile_id, alias, similarity)
                best_similarity = similarity
    
    if best_token_match:
        profile_id, matched_alias, similarity = best_token_match
        print(f"[AliasIndex] Token match: '{title}' -> '{matched_alias}' (similarity={similarity:.2f}) -> {profile_id}")
        return (profile_id, "token")

    
    # Stage 3: Fuzzy match using normalized Levenshtein (percentage-based)
    # This works consistently across strings of different lengths
    if fuzzy_threshold > 0:
        best_fuzzy = None
        best_fuzzy_similarity = 0.0
        min_similarity = 0.85  # Require 85% similarity for fuzzy match
        
        for alias in index.keys():
            similarity = normalized_levenshtein(normalized, alias)
            if similarity >= min_similarity and similarity > best_fuzzy_similarity:
                best_fuzzy = alias
                best_fuzzy_similarity = similarity
        
        if best_fuzzy:
            profile_id = index[best_fuzzy]
            print(f"[AliasIndex] Fuzzy match: '{title}' -> '{best_fuzzy}' (similarity={best_fuzzy_similarity:.2f}) -> {profile_id}")
            return (profile_id, "fuzzy")
    
    return None


def reload_alias_index() -> None:
    """Force rebuild of the alias index (e.g., after new profile created)."""
    global _INDEX_BUILT
    _ALIAS_INDEX.clear()
    _INDEX_BUILT = False
    _build_alias_index()


# ============================================================================
# SERIES DETECTION - Disambiguation and Lore Sharing
# ============================================================================

def find_profiles_by_series_group(series_group: str) -> List[Dict[str, Any]]:
    """
    Find all profiles that belong to a series group.
    
    Args:
        series_group: The series group identifier (e.g., "dragon_ball")
        
    Returns:
        List of profile info dicts sorted by series_position, each containing:
        - id: profile ID
        - name: display name
        - series_position: chronological order
    """
    profiles_dir = Path(__file__).parent
    results = []
    
    for profile_path in profiles_dir.glob("*.yaml"):
        try:
            with open(profile_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            
            if data and data.get('series_group') == series_group:
                results.append({
                    'id': data.get('id', profile_path.stem),
                    'name': data.get('name', profile_path.stem),
                    'series_position': data.get('series_position', 999),
                })
        except Exception:
            pass
    
    # Sort by series_position
    results.sort(key=lambda x: x['series_position'])
    return results


def find_related_profiles(series_group: str) -> List[Dict[str, Any]]:
    """
    Find all profiles related to a series group, including:
    1. Canonical siblings (same series_group)
    2. Spinoffs/alternates (related_franchise points to this series_group)
    
    Args:
        series_group: The series group identifier (e.g., "dragon_ball")
        
    Returns:
        List of profile info dicts, canonical first then alternates/spinoffs
    """
    profiles_dir = Path(__file__).parent
    canonical = []
    related = []
    
    for profile_path in profiles_dir.glob("*.yaml"):
        try:
            with open(profile_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            
            if not data:
                continue
            
            profile_info = {
                'id': data.get('id', profile_path.stem),
                'name': data.get('name', profile_path.stem),
                'series_position': data.get('series_position', 999),
                'relation_type': data.get('relation_type', 'canonical'),
            }
            
            # Check if canonical sibling (same series_group)
            if data.get('series_group') == series_group:
                canonical.append(profile_info)
            # Check if spinoff/alternate (related_franchise points here)
            elif data.get('related_franchise') == series_group:
                related.append(profile_info)
                
        except Exception:
            pass
    
    # Sort canonical by position, related alphabetically
    canonical.sort(key=lambda x: x['series_position'])
    related.sort(key=lambda x: x['name'])
    
    return canonical + related


def get_series_disambiguation(profile_id: str) -> Optional[List[Dict[str, Any]]]:
    """
    Check if a profile is part of a series and return disambiguation options.
    
    Includes both canonical siblings AND spinoffs/alternates that link via related_franchise.
    
    Args:
        profile_id: The matched profile ID
        
    Returns:
        List of related profiles if disambiguation needed, None otherwise
    """
    profiles_dir = Path(__file__).parent
    profile_path = profiles_dir / f"{profile_id}.yaml"
    
    if not profile_path.exists():
        return None
    
    try:
        with open(profile_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        
        series_group = data.get('series_group') if data else None
        
        if not series_group:
            return None  # Standalone, no disambiguation needed
        
        # Find ALL related profiles (canonical + spinoffs/alternates)
        related = find_related_profiles(series_group)
        
        # Only disambiguate if multiple profiles exist
        if len(related) > 1:
            return related
        
        return None
        
    except Exception:
        return None



# ============================================================================
# LORE SHARING - Inherit from parent profiles
# ============================================================================

def get_series_parent_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    """
    Get the parent profile if this profile has series_parent set.
    
    Args:
        profile_id: The profile to check
        
    Returns:
        Parent profile dict or None
    """
    profiles_dir = Path(__file__).parent
    profile_path = profiles_dir / f"{profile_id}.yaml"
    
    if not profile_path.exists():
        return None
    
    try:
        with open(profile_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        
        parent_id = data.get('series_parent') if data else None
        
        if not parent_id:
            return None
        
        parent_path = profiles_dir / f"{parent_id}.yaml"
        if not parent_path.exists():
            return None
        
        with open(parent_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
            
    except Exception:
        return None


def load_profile_with_inheritance(profile_id: str) -> NarrativeProfile:
    """
    Load a profile with inherited fields from series_parent.
    
    Inheritance rules:
    - power_system: Inherit from parent if not defined
    - combat_system: Inherit from parent if not defined
    - DNA scales: Use child's values (no inheritance)
    - tropes: Use child's values (no inheritance)
    
    Args:
        profile_id: Profile ID to load
        
    Returns:
        NarrativeProfile with inherited fields merged
    """
    # Load the main profile
    profile = load_profile(profile_id, fallback=False)
    
    # Check for parent
    parent_data = get_series_parent_profile(profile_id)
    
    if not parent_data:
        return profile  # No inheritance needed
    
    # Inherit power_system if not defined
    if not profile.power_system and parent_data.get('power_system'):
        profile.power_system = parent_data['power_system']
        print(f"[Inheritance] {profile_id} inherited power_system from {parent_data.get('id')}")
    
    # Inherit combat_system if default
    if profile.combat_system == "tactical" and parent_data.get('combat_system'):
        profile.combat_system = parent_data['combat_system']
        
    return profile


def get_related_lore(profile_id: str) -> List[str]:
    """
    Get lore file paths for related profiles in the same series.
    
    Also includes lore from related_franchise (for spinoffs/alternates).
    
    Args:
        profile_id: Profile ID to find related lore for
        
    Returns:
        List of lore file paths for profiles in the same series/franchise
    """
    profiles_dir = Path(__file__).parent
    profile_path = profiles_dir / f"{profile_id}.yaml"
    
    if not profile_path.exists():
        return []
    
    try:
        with open(profile_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        
        if not data:
            return []
        
        lore_paths = set()  # Use set to avoid duplicates
        
        # 1. Find lore from same series_group
        series_group = data.get('series_group')
        if series_group:
            related = find_profiles_by_series_group(series_group)
            for r in related:
                lore_path = profiles_dir / f"{r['id']}_lore.txt"
                if lore_path.exists():
                    lore_paths.add(str(lore_path))
        
        # 2. Also include lore from related_franchise (for spinoffs)
        related_franchise = data.get('related_franchise')
        if related_franchise:
            # Get lore from parent franchise
            parent_related = find_profiles_by_series_group(related_franchise)
            for r in parent_related:
                lore_path = profiles_dir / f"{r['id']}_lore.txt"
                if lore_path.exists():
                    lore_paths.add(str(lore_path))
        
        return list(lore_paths)
        
    except Exception:
        return []
