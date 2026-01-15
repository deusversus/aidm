"""Dice engine for random number generation."""

import random
from typing import Tuple, List, Optional, Dict, Any, Literal
from enum import Enum
from pydantic import BaseModel


class RollType(Enum):
    """Roll advantage/disadvantage type."""
    NORMAL = "normal"
    ADVANTAGE = "advantage"      # Roll 2d20, take higher
    DISADVANTAGE = "disadvantage" # Roll 2d20, take lower


class CriticalEffect(BaseModel):
    """Effects applied on critical hits/misses."""
    is_critical: bool = False
    is_critical_hit: bool = False
    is_critical_miss: bool = False
    damage_multiplier: float = 1.0
    bonus_effect: Optional[str] = None
    narrative_hint: str = ""


class RollResult(BaseModel):
    """Complete result of a die roll."""
    raw_roll: int
    modifier: int = 0
    total: int
    roll_type: str = "normal"
    threshold: Optional[int] = None
    success: bool = True
    degree: str = "success"  # critical_success, major_success, success, partial_failure, failure, critical_failure
    critical: CriticalEffect = CriticalEffect()
    all_rolls: List[int] = []  # For advantage/disadvantage, shows both rolls


def roll_d20() -> int:
    """Roll a d20."""
    return random.randint(1, 20)


def roll_dice(sides: int, count: int = 1) -> List[int]:
    """Roll multiple dice.
    
    Args:
        sides: Number of sides on each die
        count: Number of dice to roll
        
    Returns:
        List of roll results
    """
    return [random.randint(1, sides) for _ in range(count)]


def roll_with_advantage(roll_type: RollType = RollType.NORMAL) -> Tuple[int, List[int]]:
    """Roll d20 with advantage or disadvantage.
    
    Args:
        roll_type: NORMAL, ADVANTAGE, or DISADVANTAGE
        
    Returns:
        Tuple of (result, all_rolls)
    """
    if roll_type == RollType.NORMAL:
        roll = roll_d20()
        return roll, [roll]
    
    # Roll 2d20
    rolls = [roll_d20(), roll_d20()]
    
    if roll_type == RollType.ADVANTAGE:
        return max(rolls), rolls
    else:  # DISADVANTAGE
        return min(rolls), rolls


def roll_with_modifier(sides: int, modifier: int = 0) -> Tuple[int, int]:
    """Roll a die with a modifier.
    
    Args:
        sides: Number of sides on the die
        modifier: Value to add to the roll
        
    Returns:
        Tuple of (raw roll, total with modifier)
    """
    raw = random.randint(1, sides)
    return raw, raw + modifier


def get_critical_effect(
    raw_roll: int,
    is_attack: bool = False,
    profile_criticals: Optional[Dict[str, Any]] = None
) -> CriticalEffect:
    """Determine critical hit/miss effects.
    
    Args:
        raw_roll: The raw d20 roll (before modifiers)
        is_attack: Whether this is an attack roll (affects damage)
        profile_criticals: Optional profile-specific critical rules
        
    Returns:
        CriticalEffect with multipliers and narrative hints
    """
    effect = CriticalEffect()
    
    # Natural 20 - Critical Hit
    if raw_roll == 20:
        effect.is_critical = True
        effect.is_critical_hit = True
        effect.damage_multiplier = 2.0
        effect.narrative_hint = "A perfect strike!"
        
        # Profile-specific critical bonuses
        if profile_criticals:
            if profile_criticals.get("sakuga_on_crit"):
                effect.bonus_effect = "sakuga_moment"
                effect.narrative_hint = "A SAKUGA MOMENT! Time slows as the perfect attack lands!"
            if profile_criticals.get("crit_multiplier"):
                effect.damage_multiplier = profile_criticals["crit_multiplier"]
    
    # Natural 1 - Critical Miss
    elif raw_roll == 1:
        effect.is_critical = True
        effect.is_critical_miss = True
        effect.damage_multiplier = 0.0  # Miss deals no damage
        effect.narrative_hint = "A catastrophic failure!"
        
        # Profile-specific failure effects
        if profile_criticals:
            if profile_criticals.get("comedy_failures"):
                effect.bonus_effect = "comedy_moment"
                effect.narrative_hint = "A spectacular, anime-comedy-worthy failure!"
            elif profile_criticals.get("dark_failures"):
                effect.bonus_effect = "consequence"
                effect.narrative_hint = "The failure has dire consequences..."
    
    return effect


def check_threshold(roll: int, threshold: int) -> Tuple[bool, str]:
    """Check if a roll meets a threshold.
    
    Args:
        roll: The roll result
        threshold: The DC/threshold to meet
        
    Returns:
        Tuple of (success, description)
    """
    diff = roll - threshold
    
    if roll == 20:
        return True, "critical_success"
    elif roll == 1:
        return False, "critical_failure"
    elif diff >= 10:
        return True, "major_success"
    elif diff >= 0:
        return True, "success"
    elif diff >= -5:
        return False, "partial_failure"
    else:
        return False, "failure"


def roll_check(
    threshold: int,
    modifier: int = 0,
    roll_type: RollType = RollType.NORMAL,
    is_attack: bool = False,
    profile_criticals: Optional[Dict[str, Any]] = None
) -> RollResult:
    """Perform a complete roll check with all enhancements.
    
    Args:
        threshold: DC/target number to beat
        modifier: Bonus/penalty to add to roll
        roll_type: NORMAL, ADVANTAGE, or DISADVANTAGE
        is_attack: Whether this is an attack (for damage crits)
        profile_criticals: Profile-specific critical rules
        
    Returns:
        Complete RollResult with all details
    """
    # Roll with advantage/disadvantage
    raw_roll, all_rolls = roll_with_advantage(roll_type)
    total = raw_roll + modifier
    
    # Check threshold
    success, degree = check_threshold(raw_roll, threshold)
    
    # Get critical effect
    critical = get_critical_effect(raw_roll, is_attack, profile_criticals)
    
    return RollResult(
        raw_roll=raw_roll,
        modifier=modifier,
        total=total,
        roll_type=roll_type.value,
        threshold=threshold,
        success=success,
        degree=degree,
        critical=critical,
        all_rolls=all_rolls
    )


def get_profile_modifiers(profile: Any, action_type: str) -> Dict[str, Any]:
    """Get profile-specific roll modifiers.
    
    Args:
        profile: NarrativeProfile object
        action_type: Type of action (combat, social, exploration, etc.)
        
    Returns:
        Dict with modifier, advantage, and critical rules
    """
    modifiers: Dict[str, Any] = {
        "modifier": 0,
        "roll_type": RollType.NORMAL,
        "criticals": {}
    }
    
    if not profile:
        return modifiers
    
    # Check profile tropes for special rules
    tropes = getattr(profile, 'tropes', {}) or {}
    
    # Power fantasy profiles give bonuses
    dna = getattr(profile, 'dna_scales', {}) or getattr(profile, 'dna', {}) or {}
    power_fantasy = dna.get("power_fantasy_vs_struggle", 5)
    
    if power_fantasy >= 8:
        # Power fantasy: easier rolls
        modifiers["modifier"] = 2
        modifiers["criticals"]["sakuga_on_crit"] = True
        modifiers["criticals"]["crit_multiplier"] = 3.0
    elif power_fantasy <= 2:
        # Struggle profile: harder, more consequences
        modifiers["modifier"] = -1
        modifiers["criticals"]["dark_failures"] = True
    
    # Comedy profiles get comedy failures
    comedy = dna.get("comedy_vs_drama", 5)
    if comedy >= 7:
        modifiers["criticals"]["comedy_failures"] = True
    
    # Tactical profiles get advantage on planned actions
    tactical = dna.get("tactical_vs_instinctive", 5)
    if tactical >= 8 and action_type in ["attack", "skill"]:
        modifiers["roll_type"] = RollType.ADVANTAGE
    
    return modifiers


def random_float(min_val: float = 0.0, max_val: float = 1.0) -> float:
    """Generate a random float in range.
    
    Args:
        min_val: Minimum value
        max_val: Maximum value
        
    Returns:
        Random float between min and max
    """
    return random.uniform(min_val, max_val)

