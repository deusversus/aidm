"""World Builder Agent - Extract and validate player world-building assertions."""

from pydantic import BaseModel, Field
from typing import Literal, Optional, List, Dict, Any
from .base import BaseAgent


import logging

logger = logging.getLogger(__name__)

class WorldBuildingEntity(BaseModel):
    """A single entity being asserted by the player."""
    
    entity_type: Literal["npc", "item", "location", "faction", "event", "ability", "relationship"] = Field(
        description="Type of entity being created or referenced"
    )
    name: str = Field(
        description="Name of the entity"
    )
    details: Dict[str, Any] = Field(
        default_factory=dict,
        description="Additional details about the entity (role, description, properties, etc.)"
    )
    implied_backstory: Optional[str] = Field(
        default=None,
        description="Any backstory or history implied by this assertion"
    )
    is_new: bool = Field(
        default=True,
        description="True if this is a new entity, False if referencing existing"
    )


class WorldBuildingOutput(BaseModel):
    """Output from world building validation."""
    
    entities: List[WorldBuildingEntity] = Field(
        default_factory=list,
        description="List of entities extracted from the player's assertion"
    )
    validation_status: Literal["accepted", "needs_clarification", "rejected"] = Field(
        description="Whether the assertion is valid"
    )
    rejection_reason: Optional[str] = Field(
        default=None,
        description="If rejected, why (in-character explanation)"
    )
    clarification_question: Optional[str] = Field(
        default=None,
        description="If needs_clarification, what to ask the player"
    )
    power_creep_warning: bool = Field(
        default=False,
        description="True if the assertion seems to grant excessive power"
    )
    canon_conflict: bool = Field(
        default=False,
        description="True if the assertion conflicts with established canon"
    )
    narrative_integration: Optional[str] = Field(
        default=None,
        description="How to naturally integrate this into the narrative"
    )


class WorldBuilderAgent(BaseAgent):
    """Extract and validate player world-building assertions.
    
    When players assert facts about the world mid-action (creating NPCs,
    referencing items, establishing backstory), this agent:
    1. Extracts the entities being created/referenced
    2. Validates against canon mode, power tier, and consistency
    3. Decides to accept, reject, or request clarification
    """
    
    agent_name = "world_builder"
    
    @property
    def output_schema(self):
        return WorldBuildingOutput
    
    @property
    def system_prompt(self) -> str:
        return self._load_prompt_file("world_builder.md", "You are a world-building validator.")
    
    async def call(
        self,
        player_input: str,
        character_context: str = "",
        canonicality: Dict[str, str] = None,
        power_tier: str = "T10",
        established_facts: str = "",
        mode: Literal["validate", "extract_only"] = "validate",
        profile_id: Optional[str] = None,
        **kwargs
    ) -> WorldBuildingOutput:
        """Call the world builder with context.
        
        Args:
            player_input: The player's action text (or DM narrative for extract_only mode)
            character_context: Summary of the character
            canonicality: Dict with timeline_mode, canon_cast_mode, event_fidelity
            power_tier: Character's power tier (T1-T10)
            established_facts: Summary of established world facts
            mode: "validate" for player input, "extract_only" for DM narratives
            profile_id: Optional profile ID for wiki-grounded canon lookup
        """
        canonicality = canonicality or {}
        
        if mode == "extract_only":
            # EXTRACT ONLY: DM narrative mining, no validation needed
            context_message = f"""## DM NARRATIVE (Extract Only)

{player_input}

---

## EXTRACTION MODE INSTRUCTIONS

This is a DM-generated narrative. The DM is authoritative - DO NOT validate or reject.

Your ONLY job is to EXTRACT named entities introduced in this narrative:
- Named NPCs (proper nouns that refer to people/characters)
- Named locations (specific named places mentioned)
- Named items: ONLY tangible physical objects the character **received, found, picked up,
  was given, bought, or now possesses**. Do NOT extract items that are merely mentioned,
  described in the environment, referenced in dialogue, or part of a memory/flashback.
  If the character didn't actually ACQUIRE it this turn, it is NOT an inventory item.
- Named factions/organizations

**CRITICAL**: Only extract entities with ACTUAL NAMES (proper nouns).
Do NOT extract generic references like "the guard" or "a merchant".
Do NOT extract abstract concepts, memories, feelings, or narrative elements as items.

Always return validation_status="accepted" in extract_only mode.

If no named entities are found, return an empty entities list."""
        else:
            # VALIDATE MODE: Standard player input validation
            # Wiki-grounded canon lookup (Phase 3 enhancement)
            canon_reference = ""
            if profile_id:
                canon_reference = self._query_wiki_canon(profile_id, player_input)
            
            context_message = f"""## Player Action
{player_input}

## Character Context
{character_context}

## Canonicality Rules
- Timeline Mode: {canonicality.get('timeline_mode', 'not set')}
- Canon Cast Mode: {canonicality.get('canon_cast_mode', 'not set')}
- Event Fidelity: {canonicality.get('event_fidelity', 'not set')}

## Character Power Tier
{power_tier}

## Established World Facts
{established_facts or 'No specific facts established yet.'}
{canon_reference}
---

Extract and validate any world-building assertions in this player action."""
        
        return await super().call(context_message)
    
    def _query_wiki_canon(self, profile_id: str, player_input: str) -> str:
        """Query ProfileLibrary for wiki content relevant to the player's assertion.
        
        Searches across multiple page types to find canon evidence for validation.
        Returns formatted text to inject into the LLM context, or empty string.
        """
        from ..context.profile_library import get_profile_library
        
        try:
            lib = get_profile_library()
            
            # Broad search for anything matching the player's input
            results = lib.search_lore(profile_id, player_input, limit=3)
            
            if not results:
                return ""
            
            # Format as canon reference block
            chunks_text = "\n\n".join(f"- {chunk}" for chunk in results)
            return f"""
## Canon Reference (from wiki)
The following canon information was retrieved from the series wiki.
Use this to validate whether the player's assertions are consistent with established lore.

{chunks_text}
"""
        except Exception as e:
            logger.error(f"Wiki canon lookup failed: {e}")
            return ""

