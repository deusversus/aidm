"""
Title normalization and fuzzy matching utilities for anime profile lookup.
"""
import re
from typing import Optional, Dict, List, Tuple


def normalize_title(title: str) -> str:
    """
    Normalize an anime title for matching.
    
    Transformations:
    - Lowercase
    - Strip special characters (keep alphanumeric and spaces)
    - Collapse multiple spaces to single space
    - Strip leading/trailing whitespace
    
    Examples:
        "Dragon Ball Z" -> "dragon ball z"
        "JoJo's Bizarre Adventure" -> "jojos bizarre adventure"
        "Re:ZERO" -> "re zero"
    """
    if not title:
        return ""
    
    # Lowercase
    result = title.lower()
    
    # Replace non-alphanumeric (except spaces) with nothing
    result = re.sub(r'[^a-z0-9\s]', '', result)
    
    # Collapse multiple spaces
    result = re.sub(r'\s+', ' ', result)
    
    # Strip
    return result.strip()


def normalize_for_filename(title: str) -> str:
    """
    Normalize title for use in filenames.
    
    Transformations:
    - Lowercase
    - Replace spaces with underscores
    - Strip special characters
    - Limit to 100 characters
    
    Examples:
        "Dragon Ball Z" -> "dragon_ball_z"
        "JoJo's Bizarre Adventure" -> "jojos_bizarre_adventure"
    """
    normalized = normalize_title(title)
    # Replace spaces with underscores
    result = normalized.replace(' ', '_')
    # Limit length
    return result[:100]


def levenshtein_distance(s1: str, s2: str) -> int:
    """
    Calculate the Levenshtein (edit) distance between two strings.
    
    This is the minimum number of single-character edits (insertions,
    deletions, or substitutions) required to change one string into the other.
    
    Args:
        s1: First string
        s2: Second string
        
    Returns:
        Integer edit distance
    """
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = range(len(s2) + 1)
    
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            # Insertions, deletions, substitutions
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]


def find_closest_match(
    query: str, 
    candidates: List[str], 
    threshold: int = 3
) -> Optional[Tuple[str, int]]:
    """
    Find the closest matching string from a list of candidates.
    
    Args:
        query: The search string (should be normalized)
        candidates: List of candidate strings to match against
        threshold: Maximum edit distance to consider a match
        
    Returns:
        Tuple of (best_match, distance) if found within threshold, else None
    """
    if not query or not candidates:
        return None
    
    best_match = None
    best_distance = float('inf')
    
    for candidate in candidates:
        distance = levenshtein_distance(query, candidate)
        if distance < best_distance:
            best_distance = distance
            best_match = candidate
    
    if best_distance <= threshold:
        return (best_match, best_distance)
    
    return None


def tokenize_title(title: str) -> set:
    """
    Split a normalized title into word tokens.
    
    Args:
        title: The title to tokenize (should be normalized or will be)
        
    Returns:
        Set of word tokens
        
    Examples:
        "dragon ball z" -> {"dragon", "ball", "z"}
        "Re:ZERO" -> {"re", "zero"}
    """
    normalized = normalize_title(title)
    return set(normalized.split()) if normalized else set()


def jaccard_similarity(set_a: set, set_b: set) -> float:
    """
    Calculate Jaccard similarity between two sets.
    
    The Jaccard index measures the overlap between two sets:
    J(A, B) = |A ∩ B| / |A ∪ B|
    
    Args:
        set_a: First set
        set_b: Second set
        
    Returns:
        Float between 0.0 (no overlap) and 1.0 (identical sets)
    """
    if not set_a or not set_b:
        return 0.0
    
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    
    return intersection / union if union > 0 else 0.0


def token_subset_match(alias_tokens: set, query_tokens: set, min_alias_tokens: int = 1) -> bool:
    """
    Check if alias tokens form a subset of query tokens.
    
    This supports matching "Dragon Ball" (alias) against "Dragon Ball Z" (query),
    but NOT "re" (alias) against "arifureta" (query) because they're different words.
    
    Args:
        alias_tokens: Set of tokens from the alias
        query_tokens: Set of tokens from the query
        min_alias_tokens: Minimum alias token count (default 1)
        
    Returns:
        True if all alias tokens appear in query tokens
        
    Examples:
        {"dragon", "ball"} ⊆ {"dragon", "ball", "z"} -> True
        {"re"} ⊆ {"arifureta"} -> False (different tokens)
    """
    if not alias_tokens or len(alias_tokens) < min_alias_tokens:
        return False
    
    return alias_tokens.issubset(query_tokens)


def normalized_levenshtein(s1: str, s2: str) -> float:
    """
    Calculate normalized Levenshtein similarity.
    
    Unlike raw edit distance, this returns a percentage similarity
    that works consistently across strings of different lengths.
    
    Formula: 1 - (distance / max(len(s1), len(s2)))
    
    Args:
        s1: First string
        s2: Second string
        
    Returns:
        Float between 0.0 (completely different) and 1.0 (identical)
        
    Examples:
        "naruto" vs "naruko" -> ~0.83 (1 edit in 6 chars)
        "fullmetal alchemist" vs "fullmetal alchemist brotherhood" -> ~0.61
    """
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    
    distance = levenshtein_distance(s1, s2)
    max_len = max(len(s1), len(s2))
    
    return 1.0 - (distance / max_len)


def generate_aliases(canonical_name: str) -> List[str]:
    """
    Generate common aliases from a canonical anime name.
    
    Generates:
    - Normalized lowercase version
    - No-space version (for "Dragon Ball" -> "dragonball")
    - Common abbreviation (first letters)
    
    Args:
        canonical_name: The canonical anime name
        
    Returns:
        List of alias strings (all normalized)
    """
    aliases = set()
    
    normalized = normalize_title(canonical_name)
    aliases.add(normalized)
    
    # No-space version
    no_space = normalized.replace(' ', '')
    if no_space != normalized:
        aliases.add(no_space)
    
    # Abbreviation (e.g., "Attack on Titan" -> "aot")
    words = normalized.split()
    if len(words) > 1:
        # Skip common words like "the", "of", "on", "a"
        skip_words = {'the', 'of', 'on', 'a', 'an', 'no'}
        abbrev = ''.join(w[0] for w in words if w not in skip_words and len(w) > 0)
        if len(abbrev) >= 2:
            aliases.add(abbrev)
    
    return list(aliases)
