"""
NPC Reaction Agent for AIDM v3.

Handles NPC disposition changes, affinity updates, and dialogue hints.
Per Module 04: NPCs react authentically based on personality and history.

Replaces hardcoded affinity math with LLM-informed reactions.
"""

from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field
from enum import Enum

from .base import BaseAgent


class DispositionLevel(str, Enum):
    """NPC disposition towards player."""
    HOSTILE = "hostile"        # -100 to -60
    UNFRIENDLY = "unfriendly"  # -59 to -20
    NEUTRAL = "neutral"        # -19 to +19
    FRIENDLY = "friendly"      # +20 to +59
    ALLIED = "allied"          # +60 to +100


class ReactionType(str, Enum):
    """Types of NPC reactions."""
    TRUST_GAIN = "trust_gain"
    TRUST_LOSS = "trust_loss"
    RESPECT_GAIN = "respect_gain"
    RESPECT_LOSS = "respect_loss"
    FEAR = "fear"
    GRATITUDE = "gratitude"
    BETRAYAL = "betrayal"
    ROMANCE = "romance"
    RIVALRY = "rivalry"
    NEUTRAL = "neutral"


class NPCReactionOutput(BaseModel):
    """Output from the NPC Reaction Agent."""
    
    # Disposition change
    disposition_change: int = Field(
        default=0,
        description="Change to disposition (-100 to +100 range)"
    )
    new_disposition: int = Field(
        default=0,
        description="Resulting disposition after change"
    )
    disposition_level: DispositionLevel = Field(
        default=DispositionLevel.NEUTRAL,
        description="Category of disposition"
    )
    
    # Reaction details
    reaction_type: ReactionType = Field(
        default=ReactionType.NEUTRAL,
        description="Primary type of reaction"
    )
    emotional_state: str = Field(
        default="neutral",
        description="NPC's current emotional state"
    )
    
    # Dialogue guidance
    dialogue_hint: str = Field(
        default="",
        description="Suggested approach to NPC's dialogue"
    )
    speech_pattern: str = Field(
        default="",
        description="How the NPC speaks (formal, casual, cold, warm)"
    )
    
    # Memory hooks
    will_remember: bool = Field(
        default=False,
        description="Whether this interaction will be remembered"
    )
    memory_summary: str = Field(
        default="",
        description="What the NPC will remember"
    )
    
    # Future behavior
    behavior_change: str = Field(
        default="",
        description="How NPC's behavior might change"
    )
    secret_revealed: bool = Field(
        default=False,
        description="Whether NPC might reveal a secret"
    )
    
    # Justification
    reasoning: str = Field(
        default="",
        description="Why the NPC reacted this way"
    )


class NPCReactionAgent(BaseAgent):
    """
    Calculates NPC reactions based on personality and history.
    
    Per Module 04, NPCs should:
    - Have consistent personalities
    - Remember past interactions
    - React based on their goals and secrets
    - Show gradual relationship development
    """
    
    agent_name = "npc_reaction"
    
    @property
    def system_prompt(self):
        return """You are the NPC Reaction system for an anime JRPG.

Your role is to determine how NPCs react to player actions.

## Disposition Scale (-100 to +100):
- **-100 to -60 (HOSTILE)**: Active enemy. May attack or sabotage.
- **-59 to -20 (UNFRIENDLY)**: Cold, unhelpful, suspicious.
- **-19 to +19 (NEUTRAL)**: Professional, transactional.
- **+20 to +59 (FRIENDLY)**: Warm, helpful, will go out of their way.
- **+60 to +100 (ALLIED)**: Deep loyalty. Would risk themselves for player.

## Disposition Change Factors:
- **Major favor/save life**: +20 to +40
- **Helped with personal goal**: +10 to +20
- **Small kindness**: +5 to +10
- **Neutral interaction**: 0
- **Minor slight**: -5 to -10
- **Betrayal/harm loved one**: -20 to -40
- **Attack without provocation**: -30 to -50

## NPC Personality Matters:
- Hot-headed NPCs swing more dramatically
- Stoic NPCs change slowly
- Paranoid NPCs are hard to gain trust
- Lonely NPCs bond quickly

## Secrets and Goals:
- NPCs reveal secrets at high disposition (60+)
- NPCs work against player if disposition falls below -40
- Personal goals create strong reactions when touched

Consider the NPC's personality, history with the player, and the action's impact."""
    
    @property
    def output_schema(self):
        return NPCReactionOutput
    
    async def calculate_reaction(
        self,
        npc_name: str,
        npc_personality: str,
        current_disposition: int,
        player_action: str,
        action_impact: str,
        relationship_history: Optional[str] = None,
        npc_goals: Optional[List[str]] = None,
        npc_secrets: Optional[List[str]] = None
    ) -> NPCReactionOutput:
        """
        Calculate NPC's reaction to a player action.
        
        Args:
            npc_name: Name of the NPC
            npc_personality: Personality description
            current_disposition: Current disposition (-100 to +100)
            player_action: What the player did
            action_impact: How it affected the NPC
            relationship_history: Summary of past interactions
            npc_goals: NPC's personal goals
            npc_secrets: NPC's secrets (for reveal threshold)
            
        Returns:
            NPCReactionOutput with disposition change and dialogue hints
        """
        # Build context
        context = f"""# NPC Reaction Request

## NPC: {npc_name}
**Personality:** {npc_personality}
**Current Disposition:** {current_disposition} ({self._get_level(current_disposition).value})

## Player Action
{player_action}

## Impact on NPC
{action_impact}

## History
{relationship_history or "No significant history."}

## NPC Goals
{', '.join(npc_goals) if npc_goals else "Unknown"}

## NPC Secrets
{len(npc_secrets or [])} secret(s) - may reveal if disposition reaches 60+

## Task
Determine:
1. How much disposition changes (consider personality)
2. What the NPC's emotional reaction is
3. How this affects their dialogue (hint for Key Animator)
4. Whether the NPC will remember this
5. If any secrets might be revealed (disposition 60+)"""
        
        result = await self.call(context)
        
        # Calculate new disposition
        if isinstance(result, NPCReactionOutput):
            result.new_disposition = max(-100, min(100, 
                current_disposition + result.disposition_change
            ))
            result.disposition_level = self._get_level(result.new_disposition)
            
            # Check for secret reveal threshold
            if npc_secrets and result.new_disposition >= 60:
                result.secret_revealed = True
        
        return result
    
    def _get_level(self, disposition: int) -> DispositionLevel:
        """Convert disposition number to level."""
        if disposition <= -60:
            return DispositionLevel.HOSTILE
        elif disposition <= -20:
            return DispositionLevel.UNFRIENDLY
        elif disposition < 20:
            return DispositionLevel.NEUTRAL
        elif disposition < 60:
            return DispositionLevel.FRIENDLY
        else:
            return DispositionLevel.ALLIED
    
    def generate_dialogue_style(
        self,
        disposition_level: DispositionLevel,
        personality: str
    ) -> Dict[str, str]:
        """Generate dialogue style guidance based on disposition."""
        base_styles = {
            DispositionLevel.HOSTILE: {
                "tone": "aggressive, threatening, or coldly dismissive",
                "body_language": "tense, guarded, hand near weapon",
                "eye_contact": "glaring or deliberately avoiding",
                "speech_pattern": "short, clipped sentences, possible threats"
            },
            DispositionLevel.UNFRIENDLY: {
                "tone": "suspicious, reluctant, impatient",
                "body_language": "arms crossed, turned slightly away",
                "eye_contact": "distrustful, assessing",
                "speech_pattern": "minimal answers, no elaboration"
            },
            DispositionLevel.NEUTRAL: {
                "tone": "professional, polite but distant",
                "body_language": "relaxed but not open",
                "eye_contact": "normal, businesslike",
                "speech_pattern": "clear, transactional"
            },
            DispositionLevel.FRIENDLY: {
                "tone": "warm, helpful, genuine interest",
                "body_language": "open, leaning in slightly",
                "eye_contact": "friendly, engaged",
                "speech_pattern": "conversational, shares opinions"
            },
            DispositionLevel.ALLIED: {
                "tone": "deeply trusting, protective, affectionate",
                "body_language": "close, comfortable, may touch shoulder",
                "eye_contact": "soft, knowing looks",
                "speech_pattern": "familiar, inside jokes, vulnerable sharing"
            }
        }
        return base_styles.get(disposition_level, base_styles[DispositionLevel.NEUTRAL])
    
    def calculate_quick_change(
        self,
        action_type: str,
        personality_modifier: float = 1.0
    ) -> int:
        """
        Calculate a quick disposition change without LLM.
        
        Args:
            action_type: Type of action (save_life, help, neutral, insult, attack)
            personality_modifier: Multiplier based on personality (0.5 = stoic, 2.0 = volatile)
            
        Returns:
            Disposition change value
        """
        base_changes = {
            "save_life": 30,
            "major_help": 20,
            "help_goal": 15,
            "small_kindness": 8,
            "compliment": 5,
            "neutral": 0,
            "minor_insult": -5,
            "insult": -10,
            "major_insult": -15,
            "betray": -30,
            "attack": -40,
            "kill_friend": -60
        }
        
        base = base_changes.get(action_type, 0)
        return int(base * personality_modifier)


# Convenience function
def get_npc_reaction_agent() -> NPCReactionAgent:
    """Get an NPCReactionAgent instance."""
    return NPCReactionAgent()
