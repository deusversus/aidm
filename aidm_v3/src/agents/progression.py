"""
Progression Agent for AIDM v3.

XP/leveling system per Module 09 spec:
- XP award calculation based on achievements
- Level-up detection and handling
- Skill/ability acquisition
- Profile-specific leveling curves
"""

from typing import List, Dict, Any, Optional, Literal
from pydantic import BaseModel, Field

from .base import BaseAgent
from ..db.models import Character
from ..profiles.loader import NarrativeProfile
from ..context.rule_library import RuleLibrary


# XP curves per growth model
XP_CURVES = {
    "fast": {
        "base_xp_per_session": 1000,
        "xp_per_level": [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500],  # L1-10
        "description": "Rapid progression (isekai, tournament arcs)"
    },
    "moderate": {
        "base_xp_per_session": 600,
        "xp_per_level": [0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400],
        "description": "Standard shonen progression"
    },
    "slow": {
        "base_xp_per_session": 300,
        "xp_per_level": [0, 300, 700, 1200, 1800, 2500, 3300, 4200, 5200, 6300],
        "description": "Realistic/seinen progression"
    }
}

# XP sources and multipliers
XP_SOURCES = {
    "combat": 1.0,       # Standard combat XP
    "boss": 2.0,         # Boss encounters
    "quest": 1.5,        # Quest completion
    "roleplay": 0.8,     # Character development
    "discovery": 0.5,    # Exploration/lore
    "failure": 0.3,      # Learning from failure (struggle profiles)
    "sakuga": 1.5,       # Epic moment bonus
}


class XPAward(BaseModel):
    """XP from a single source."""
    source: str
    amount: int
    reason: str


class ProgressionOutput(BaseModel):
    """Result of progression check."""
    xp_awarded: int = 0
    xp_sources: List[XPAward] = Field(default_factory=list)
    
    # Level up
    level_up: bool = False
    old_level: int = 0
    new_level: int = 0
    
    # Unlocks
    abilities_unlocked: List[str] = Field(default_factory=list)
    stats_increased: Dict[str, int] = Field(default_factory=dict)
    
    # Tier shift
    tier_changed: bool = False
    old_tier: Optional[str] = None
    new_tier: Optional[str] = None
    tier_ceremony: Optional[str] = None
    tier_change_memory: Optional[str] = None  # Memory content for POWER_TIER_CHANGE
    
    # Narrative
    level_up_narrative: str = ""
    growth_moment: bool = False


class ProgressionAgent(BaseAgent):
    """
    The Progression Manager. Calculates XP and handles level-ups.
    
    Uses profile-specific growth models (fast/moderate/slow) to determine
    progression pacing. Per v3 philosophy: keeps power fantasy alive while
    respecting narrative style.
    """
    
    agent_name = "progression"
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
    
    @property
    def system_prompt(self):
        return """You are the Progression system for an anime JRPG.
        
Your role is to:
1. Calculate XP awards that feel appropriate to the narrative profile
2. Determine what abilities/stats should increase on level-up
3. Generate narrative moments for significant growth
4. Detect tier shifts (major power milestones)

Consider:
- Profile's growth model (fast isekai vs slow seinen)
- Player's recent achievements
- Story beat (is this an arc climax?)
- Anime tropes (training arcs, power-ups, transformations)

Level-ups should feel ANIME. Not just "+1 STR"."""
    
    @property
    def output_schema(self):
        return ProgressionOutput
    
    async def calculate_progression(
        self,
        character: Character,
        turn_result: Dict[str, Any],
        profile: NarrativeProfile,
        session_context: Optional[Dict[str, Any]] = None
    ) -> ProgressionOutput:
        """
        Calculate XP and check for level-ups.
        
        Args:
            character: The character to progress
            turn_result: Results from the completed turn
            profile: Active narrative profile
            session_context: Optional session-level context
            
        Returns:
            ProgressionOutput with XP and level-up info
        """
        # Get growth model from profile
        growth_model = self._get_growth_model(profile)
        
        # Calculate XP from various sources
        xp_awards = self._calculate_xp_awards(turn_result, profile, growth_model)
        total_xp = sum(award.amount for award in xp_awards)
        
        # Check for level up
        result = ProgressionOutput(
            xp_awarded=total_xp,
            xp_sources=xp_awards,
            old_level=character.level
        )
        
        # Apply XP and check level
        new_xp = (character.xp_current or 0) + total_xp
        xp_to_next = self._get_xp_for_level(character.level + 1, growth_model)
        
        if new_xp >= xp_to_next:
            result.level_up = True
            result.new_level = character.level + 1
            result = await self._handle_level_up(result, character, profile)
        else:
            result.new_level = character.level
        
        return result
    
    def _get_growth_model(self, profile: NarrativeProfile) -> str:
        """Determine growth model from profile DNA."""
        # Use Fast vs Slow DNA scale
        pacing = profile.dna.get("fast_vs_slow", 5)
        
        if pacing <= 3:
            return "fast"
        elif pacing >= 7:
            return "slow"
        else:
            return "moderate"
    
    def _get_xp_for_level(self, level: int, growth_model: str) -> int:
        """Get XP required for a level."""
        curve = XP_CURVES.get(growth_model, XP_CURVES["moderate"])
        xp_per_level = curve["xp_per_level"]
        
        if level <= 0:
            return 0
        elif level <= len(xp_per_level):
            return xp_per_level[level - 1]
        else:
            # Extrapolate for higher levels
            base = xp_per_level[-1]
            return base + (level - len(xp_per_level)) * 1000
    
    def _calculate_xp_awards(
        self,
        turn_result: Dict[str, Any],
        profile: NarrativeProfile,
        growth_model: str
    ) -> List[XPAward]:
        """Calculate XP from turn results."""
        awards = []
        base_xp = XP_CURVES[growth_model]["base_xp_per_session"] // 10  # Per turn
        
        # Combat XP
        if turn_result.get("combat_occurred"):
            combat_xp = int(base_xp * XP_SOURCES["combat"])
            
            # Boss bonus
            if turn_result.get("boss_fight"):
                combat_xp = int(combat_xp * XP_SOURCES["boss"])
                awards.append(XPAward(
                    source="boss",
                    amount=combat_xp,
                    reason="Defeated powerful foe"
                ))
            else:
                awards.append(XPAward(
                    source="combat",
                    amount=combat_xp,
                    reason="Combat victory"
                ))
            
            # Sakuga bonus
            if turn_result.get("sakuga_moment"):
                sakuga_xp = int(base_xp * XP_SOURCES["sakuga"])
                awards.append(XPAward(
                    source="sakuga",
                    amount=sakuga_xp,
                    reason="Epic moment!"
                ))
        
        # Quest XP
        if turn_result.get("quest_completed"):
            quest_xp = int(base_xp * XP_SOURCES["quest"])
            awards.append(XPAward(
                source="quest",
                amount=quest_xp,
                reason=f"Completed: {turn_result.get('quest_name', 'quest')}"
            ))
        
        # Roleplay XP
        if turn_result.get("significant_roleplay"):
            rp_xp = int(base_xp * XP_SOURCES["roleplay"])
            awards.append(XPAward(
                source="roleplay",
                amount=rp_xp,
                reason="Character development"
            ))
        
        # Failure XP (struggle profiles only)
        power_fantasy = profile.dna.get("power_fantasy_vs_struggle", 5)
        if turn_result.get("failed_significantly") and power_fantasy >= 7:
            fail_xp = int(base_xp * XP_SOURCES["failure"])
            awards.append(XPAward(
                source="failure",
                amount=fail_xp,
                reason="Learned from failure"
            ))
        
        # Discovery XP
        if turn_result.get("discovered_lore"):
            disc_xp = int(base_xp * XP_SOURCES["discovery"])
            awards.append(XPAward(
                source="discovery",
                amount=disc_xp,
                reason="Uncovered secrets"
            ))
        
        return awards
    
    async def _handle_level_up(
        self,
        result: ProgressionOutput,
        character: Character,
        profile: NarrativeProfile
    ) -> ProgressionOutput:
        """Handle level-up effects."""
        # Build level-up context for LLM
        level_context = f"""# Level Up Event

Character: {character.name}
Class: {character.character_class}
Old Level: {result.old_level}
New Level: {result.new_level}

Profile: {profile.name}
Combat Style: {profile.combat_style}

Current Stats: {character.stats}
Current Abilities: {character.abilities}

Determine:
1. What stats increase (2-3 points total)
2. Any new abilities unlocked at this level
3. A brief narrative moment for the level-up (anime style)
4. Is this a tier change (every 5 levels)?

Make it feel like anime growth - not just numbers!"""
        
        # Call LLM for level-up details
        level_up_details = await self.call(level_context)
        
        # Merge LLM response
        if isinstance(level_up_details, ProgressionOutput):
            result.abilities_unlocked = level_up_details.abilities_unlocked
            result.stats_increased = level_up_details.stats_increased
            result.level_up_narrative = level_up_details.level_up_narrative
            result.growth_moment = level_up_details.growth_moment
        
        # Check tier change (every 5 levels)
        old_tier_num = (result.old_level - 1) // 5
        new_tier_num = (result.new_level - 1) // 5
        
        if new_tier_num > old_tier_num:
            result.tier_changed = True
            result.old_tier = f"T{10 - old_tier_num}"
            result.new_tier = f"T{10 - new_tier_num}"
            result.tier_ceremony = self._get_tier_ceremony(result.new_tier)
            
            # Create memory content for POWER_TIER_CHANGE
            result.tier_change_memory = (
                f"POWER TIER ASCENSION: {result.old_tier} → {result.new_tier}. "
                f"{character.name} has reached a new level of power. "
                f"Context: {result.tier_ceremony}"
            )
        
        return result
    
    def _get_tier_ceremony(self, new_tier: str) -> str:
        """
        Get tier transition context for narrative generation via RAG.
        
        Retrieves ceremony text from ceremonies.yaml in RuleLibrary,
        falls back to power tier guidance if no specific ceremony found.
        """
        # Parse tier number from string (e.g., "T7" -> 7)
        try:
            tier_num = int(new_tier.replace("T", ""))
            old_tier_num = tier_num + 1  # Previous tier (T8 -> T7 means old was T8)
        except (ValueError, AttributeError):
            return f"Power tier {new_tier}: Consult power_tier_reference for narrative guidance."
        
        # Try to get ceremony text from RAG
        # Use T-format to match ceremony IDs like "ceremony_t8_t7"
        rules = RuleLibrary()
        ceremony_text = rules.get_ceremony_text(old_tier_num, tier_num)
        
        # Also try direct power tier guidance as it has the same information
        if not ceremony_text:
            ceremony_text = rules.get_power_tier_guidance(tier_num)
        
        if ceremony_text:
            return ceremony_text
        
        # Fallback: Get general power tier guidance from RAG
        tier_guidance = rules.get_power_tier_guidance(tier_num)
        if tier_guidance:
            return tier_guidance
        
        # Final fallback
        return f"Power tier {new_tier}: Consult power_tier_reference for narrative guidance."
    
    def create_tier_change_memory(
        self,
        result: ProgressionOutput,
        session_number: int = 0,
        trigger: str = ""
    ) -> Dict[str, Any]:
        """
        Create a POWER_TIER_CHANGE memory per Module 12.
        
        Args:
            result: ProgressionOutput with tier change info
            session_number: Current session number
            trigger: What caused the tier change
            
        Returns:
            Dict to be stored as memory
        """
        content = {
            "summary": f"Power tier increased: {result.old_tier} → {result.new_tier}",
            "trigger": trigger or f"Reached level {result.new_level}",
            "old_tier": result.old_tier,
            "new_tier": result.new_tier,
            "old_level": result.old_level,
            "new_level": result.new_level,
            "ceremony_narration": result.tier_ceremony,
            "session_number": session_number,
        }
        
        return {
            "summary": content["summary"],
            "category": "POWER_TIER_CHANGE",
            "heat": 90,  # High heat - important milestone
            "tags": ["plot_critical", "character_milestone", "tier_shift"],
            "content": content
        }


# Convenience function
def get_progression_agent() -> ProgressionAgent:
    """Get a ProgressionAgent instance."""
    return ProgressionAgent()
