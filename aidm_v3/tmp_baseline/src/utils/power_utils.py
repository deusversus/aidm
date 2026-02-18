"""
Power tier utilities for AIDM v3.

Handles power tier conversions and differential calculations
for the Unified Power Differential narrative system.
"""

from typing import Optional


def tier_to_number(tier: str) -> int:
    """
    Convert VS Battles tier string to numeric value.
    
    Lower number = higher power. T10=human, T1=multiversal.
    
    Args:
        tier: Tier string like "T10", "T8", "T4", "T1"
        
    Returns:
        Integer value (10 for T10, 1 for T1)
    """
    if not tier:
        return 8  # Default to T8 (street level)
    
    # Handle various formats
    tier_clean = tier.upper().strip()
    if tier_clean.startswith("T"):
        tier_clean = tier_clean[1:]
    
    try:
        return int(tier_clean)
    except ValueError:
        return 8  # Default fallback


def calculate_power_differential(
    world_tier: str,
    character_tier: str,
    threat_tier: Optional[str] = None
) -> int:
    """
    Calculate power differential between character and world/threat.
    
    Positive differential = character is stronger than baseline.
    
    Args:
        world_tier: The world's baseline tier (from profile)
        character_tier: The character's power tier
        threat_tier: Optional current threat tier (overrides world baseline)
        
    Returns:
        Power differential (positive = stronger than baseline)
        
    Examples:
        T4 character in T8 world = 8 - 4 = 4 (OP territory)
        T8 character in T8 world = 8 - 8 = 0 (standard)
        T6 character vs T4 threat = 4 - 6 = -2 (underdog)
    """
    comparison = threat_tier or world_tier
    
    world_num = tier_to_number(comparison)
    char_num = tier_to_number(character_tier)
    
    return world_num - char_num


def get_narrative_mode(differential: int) -> str:
    """
    Determine narrative mode based on power differential.
    
    Args:
        differential: Power differential (positive = character stronger)
        
    Returns:
        "standard", "blended", or "op_dominant"
    """
    if differential >= 4:
        return "op_dominant"
    elif differential >= 2:
        return "blended"
    else:
        return "standard"
