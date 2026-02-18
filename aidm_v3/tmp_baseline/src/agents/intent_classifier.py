"""Intent Classifier Agent - Parse player input into structured intent."""

from pydantic import BaseModel, Field
from typing import Literal, Optional, List
from .base import BaseAgent


INTENT_TYPES = Literal[
    "COMBAT", "SOCIAL", "EXPLORATION", "ABILITY", "INVENTORY",
    "WORLD_BUILDING", "META_FEEDBACK", "OVERRIDE_COMMAND", "OP_COMMAND", "OTHER"
]


class IntentOutput(BaseModel):
    """Structured output for intent classification."""
    
    intent: INTENT_TYPES = Field(
        description="The category of action being attempted"
    )
    action: str = Field(
        description="What the player is trying to do"
    )
    target: Optional[str] = Field(
        default=None,
        description="Who/what the action targets"
    )
    declared_epicness: float = Field(
        ge=0, 
        le=1, 
        description="How epic/dramatic the player intends this to be (0=mundane, 1=climactic)"
    )
    special_conditions: List[str] = Field(
        default_factory=list,
        description="Special flags: 'named_attack', 'power_of_friendship', 'underdog_moment', etc."
    )
    confidence: float = Field(
        ge=0, le=1, default=1.0,
        description="How confident this classification is (1.0=certain, <0.7=ambiguous)"
    )
    secondary_intent: Optional[INTENT_TYPES] = Field(
        default=None,
        description="If confidence < 0.7, the next most likely intent category"
    )


class IntentClassifier(BaseAgent):
    """Parse player input into structured intent."""
    
    agent_name = "intent_classifier"
    
    @property
    def output_schema(self):
        return IntentOutput
    
    @property
    def system_prompt(self) -> str:
        return """You are an intent classifier for an anime TTRPG system.

Parse the player's action into structured data. Focus on:

1. INTENT: What category of action is this?
   - COMBAT: Fighting, attacking, defending
   - SOCIAL: Talking, persuading, intimidating, relationship building
   - EXPLORATION: Investigating, traveling, searching, observing
   - ABILITY: Using a special power/skill outside combat
   - INVENTORY: Managing items, using/equipping gear, crafting, inspecting objects, checking bags/pockets
   - WORLD_BUILDING: Player asserts facts about world, backstory, NPCs, items, locations
     - "My childhood friend Kai..." (creating/referencing NPC)
     - "...the sword my father gave me" (creating item + NPC relationship)
     - "Back in Thornwood Village..." (creating location)
     - "Ever since the incident..." (establishing backstory event)
   - META_FEEDBACK: Player using /meta command to give feedback (e.g., "/meta more comedy please")
   - OVERRIDE_COMMAND: Player using /override command for hard constraints (e.g., "/override Kai cannot die")
   - OP_COMMAND: Player using /op command for OP Mode (e.g., "/op accept saitama", "/op dismiss")
   - OTHER: Anything else

2. ACTION: Concise description of what they're doing
   - For META_FEEDBACK: The feedback content (without "/meta" prefix)
   - For OVERRIDE_COMMAND: The constraint content (without "/override" prefix)
   - For OP_COMMAND: The subcommand (accept, dismiss) and archetype if provided

3. TARGET: Who or what are they targeting (if applicable)
   - For OVERRIDE_COMMAND: Extract the subject (NPC name, topic, etc.)
   - For OP_COMMAND: The archetype name (e.g., "saitama", "mob")

4. DECLARED_EPICNESS: How dramatic is this moment SUPPOSED to be?
   - 0.0-0.3: Mundane action (walking, casual chat, routine task)
   - 0.4-0.6: Normal action (regular attack, investigation, negotiation)  
   - 0.7-0.9: Dramatic action (named attack, emotional confrontation)
   - 1.0: Climactic moment (final blow, confession, sacrifice)
   - For META/OVERRIDE/OP commands: Always 0.0 (system commands, not story)

5. SPECIAL_CONDITIONS: Check for anime tropes:
   - 'named_attack': Player names their technique
   - 'power_of_friendship': Invoking ally bonds
   - 'underdog_moment': Fighting despite overwhelming odds
   - 'protective_rage': Fighting to protect someone
   - 'training_payoff': Using something they practiced
   - 'first_time_power': Awakening/breakthrough moment

6. CONFIDENCE: How certain are you about the primary intent?
   - 1.0: Unambiguous ("I attack the guard" → clearly COMBAT)
   - 0.5-0.7: Ambiguous ("I draw my sword and stare him down" → COMBAT or SOCIAL?)
   - If confidence < 0.7, provide secondary_intent with the next most likely category

COMMAND DETECTION:
- If input starts with "/meta " → intent = META_FEEDBACK
- If input starts with "/override " → intent = OVERRIDE_COMMAND  
- If input is "/override list" or "/override remove X" → intent = OVERRIDE_COMMAND
- If input starts with "/op " → intent = OP_COMMAND
  - "/op accept [archetype]" - Player accepts OP mode with specified archetype
  - "/op dismiss" - Player dismisses the OP suggestion

Be generous with epicness detection. If the player is TRYING to be dramatic, recognize it."""

