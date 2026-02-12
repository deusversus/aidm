"""
Combat Agent for AIDM v3.

Full JRPG combat resolution per Module 08 spec:
- Initiative order
- Action economy (move, action, bonus, reaction)
- Resource management (HP, MP, SP)
- Damage calculation with profile modifiers
- Status effect tracking
"""

from typing import List, Dict, Any, Optional, Literal
from pydantic import BaseModel, Field

from .base import BaseAgent
from .intent_classifier import IntentOutput
from ..db.models import Character, NPC
from ..db.state_manager import GameContext
from ..profiles.loader import NarrativeProfile


class ResourceCost(BaseModel):
    """Resources consumed by an action."""
    hp: int = 0
    mp: int = 0
    sp: int = 0


class CombatAction(BaseModel):
    """A parsed combat action."""
    action_type: Literal["attack", "skill", "spell", "defend", "item", "flee", "other"]
    target: str
    ability_name: Optional[str] = None
    is_named_attack: bool = False
    declared_epicness: float = 0.5  # 0-1 from intent


class CombatResult(BaseModel):
    """Result of combat resolution."""
    action_valid: bool = True
    validation_reason: Optional[str] = None
    
    # Damage/Healing
    damage_dealt: int = 0
    damage_type: str = "physical"
    healing_done: int = 0
    
    # Resources
    resources_consumed: ResourceCost = Field(default_factory=ResourceCost)
    
    # Effects
    status_applied: List[str] = Field(default_factory=list)
    status_removed: List[str] = Field(default_factory=list)
    
    # Outcome
    hit: bool = True
    critical: bool = False
    target_defeated: bool = False
    
    # Narrative guidance
    narrative_weight: Literal["minor", "standard", "significant", "climactic"] = "standard"
    combat_narrative_hint: str = ""
    sakuga_moment: bool = False


class CombatState(BaseModel):
    """Current state of an ongoing combat."""
    active: bool = False
    round_number: int = 0
    turn_order: List[str] = Field(default_factory=list)  # Character/NPC IDs
    current_turn: int = 0
    combatants: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


class CombatAgent(BaseAgent):
    """
    The Combat Manager. Resolves combat actions per M08 spec.
    
    Uses structured LLM calls for judgment (should this succeed? how dramatically?)
    rather than hardcoded formulas. Per v3 philosophy: LLM for judgment, code for computation.
    """
    
    agent_name = "combat"
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
        self._combat_state: Optional[CombatState] = None
    
    @property
    def system_prompt(self):
        return self._load_prompt_file("combat.md", "You are the Combat Resolution system for an anime JRPG.")
    
    @property
    def output_schema(self):
        return CombatResult
    
    async def resolve_action(
        self,
        action: CombatAction,
        attacker: Character,
        target_entity: Any,  # Character or NPC
        context: GameContext,
        profile: NarrativeProfile
    ) -> CombatResult:
        """
        Resolve a combat action.
        
        Args:
            action: Parsed combat action
            attacker: The attacking character
            target_entity: Target character or NPC
            context: Current game context
            profile: Active narrative profile
            
        Returns:
            CombatResult with outcomes
        """
        # Build context for LLM judgment
        combat_context = self._build_combat_context(
            action, attacker, target_entity, context, profile
        )
        
        # Call LLM for judgment
        result = await self.call(combat_context)
        
        # Apply computed damage/resources (code layer)
        result = self._apply_computations(result, action, attacker, target_entity, profile)
        
        return result
    
    def _build_combat_context(
        self,
        action: CombatAction,
        attacker: Character,
        target: Any,
        context: GameContext,
        profile: NarrativeProfile
    ) -> str:
        """Build the context prompt for combat resolution."""
        lines = ["# Combat Resolution Request"]
        
        # Profile context
        lines.append(f"\n## Narrative Profile: {profile.name}")
        lines.append(f"Combat Style: {profile.combat_style}")
        lines.append(f"Tactical Scale: {profile.dna.get('tactical_vs_instinctive', 5)}/10")
        lines.append(f"Power Fantasy: {profile.dna.get('power_fantasy_vs_struggle', 5)}/10")
        if profile.tropes.get("named_attacks"):
            lines.append("Named Attacks: ENABLED (treat with weight)")
        if profile.tropes.get("sakuga_moments"):
            lines.append("Sakuga Moments: ENABLED")
        
        # Attacker info
        lines.append(f"\n## Attacker: {attacker.name}")
        lines.append(f"Level: {attacker.level}")
        lines.append(f"Power Tier: {attacker.power_tier}")
        lines.append(f"HP: {attacker.hp_current}/{attacker.hp_max}")
        if attacker.stats:
            lines.append(f"Stats: {attacker.stats}")
        
        # Target info
        lines.append(f"\n## Target: {target.name}")
        target_tier = getattr(target, 'power_tier', 'T10')
        lines.append(f"Power Tier: {target_tier}")
        if hasattr(target, 'hp_current'):
            lines.append(f"HP: {target.hp_current}/{target.hp_max}")
        if hasattr(target, 'disposition'):
            lines.append(f"Disposition: {target.disposition}")
        
        # Action info
        lines.append(f"\n## Action")
        lines.append(f"Type: {action.action_type}")
        if action.ability_name:
            lines.append(f"Ability: {action.ability_name}")
        if action.is_named_attack:
            lines.append("⚡ NAMED ATTACK DECLARED")
        lines.append(f"Declared Epicness: {action.declared_epicness:.1f}")
        
        # Scene context
        lines.append(f"\n## Scene Context")
        if context.world_state:
            lines.append(f"Location: {context.world_state.location}")
            lines.append(f"Arc Phase: {context.world_state.arc_phase}")
            lines.append(f"Tension: {context.world_state.tension_level:.1f}")
        
        # Instructions
        lines.append("\n## Your Task")
        lines.append("Determine the outcome of this action.")
        lines.append("Consider: profile style, power tiers, story beat, player intent.")
        lines.append("If this feels like a climactic moment, set sakuga_moment=true.")
        
        return "\n".join(lines)
    
    def _apply_computations(
        self,
        result: CombatResult,
        action: CombatAction,
        attacker: Character,
        target: Any,
        profile: NarrativeProfile
    ) -> CombatResult:
        """Apply code-layer computations to the LLM result."""
        # Compute actual damage based on stats (if not already set)
        if result.hit and result.damage_dealt == 0:
            base_damage = self._calculate_base_damage(attacker, action)
            
            # Apply critical multiplier
            if result.critical:
                base_damage = int(base_damage * 1.5)
            
            # Apply profile modifiers
            if profile.combat_style == "spectacle":
                base_damage = int(base_damage * 1.2)  # Spectacle = bigger numbers
            
            result.damage_dealt = base_damage
        
        # Check if target defeated
        if hasattr(target, 'hp_current'):
            if target.hp_current - result.damage_dealt <= 0:
                result.target_defeated = True
        
        # Compute resource costs
        if action.action_type == "spell":
            result.resources_consumed.mp = 20  # Base spell cost
        elif action.action_type == "skill":
            result.resources_consumed.sp = 15  # Base skill cost
        
        return result
    
    def _calculate_base_damage(self, attacker: Character, action: CombatAction) -> int:
        """Calculate base damage from attacker stats."""
        stats = attacker.stats or {}
        
        if action.action_type in ("attack", "skill"):
            # Physical damage: STR based
            str_mod = (stats.get("str", 10) - 10) // 2
            base = 5 + str_mod + attacker.level
        elif action.action_type == "spell":
            # Magical damage: INT based
            int_mod = (stats.get("int", 10) - 10) // 2
            base = 5 + int_mod + attacker.level
        else:
            base = 5
        
        return max(1, base)
    
    def parse_combat_action(self, intent: IntentOutput, player_input: str) -> CombatAction:
        """Parse an intent into a structured combat action."""
        action_type = "attack"
        
        # Detect action type from intent
        action_text = intent.action.lower() if intent.action else ""
        if any(word in action_text for word in ["cast", "spell", "magic"]):
            action_type = "spell"
        elif any(word in action_text for word in ["skill", "technique", "ability"]):
            action_type = "skill"
        elif any(word in action_text for word in ["defend", "block", "guard"]):
            action_type = "defend"
        elif any(word in action_text for word in ["flee", "run", "escape"]):
            action_type = "flee"
        elif any(word in action_text for word in ["use", "drink", "consume"]):
            action_type = "item"
        
        # Detect named attacks
        is_named = any([
            "!" in player_input,  # Exclamation = epicness
            player_input.isupper(),  # ALL CAPS = yelling attack name
            any(word in action_text for word in ["final", "ultimate", "secret"])
        ])
        
        return CombatAction(
            action_type=action_type,
            target=intent.target if intent.target else "enemy",
            ability_name=intent.ability_name if hasattr(intent, 'ability_name') else None,
            is_named_attack=is_named,
            declared_epicness=intent.declared_epicness if hasattr(intent, 'declared_epicness') else 0.5
        )


# Convenience function
def get_combat_agent() -> CombatAgent:
    """Get a CombatAgent instance."""
    return CombatAgent()
