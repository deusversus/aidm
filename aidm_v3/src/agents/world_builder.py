"""World Builder Agent - Extract and validate player world-building assertions."""

from pydantic import BaseModel, Field
from typing import Literal, Optional, List, Dict, Any
from .base import BaseAgent


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
        return """You are a world-building validator for an anime TTRPG system.

When a player's action contains assertions about the world, backstory, NPCs, or items:

## 1. EXTRACTION

Identify ALL entities being created or referenced:

- **NPC**: "My childhood friend Kai" → NPC named Kai, role: friend
- **Item**: "the sword my father gave me" → Item (sword), NPC (father), relationship
- **Location**: "back in Thornwood Village" → Location named Thornwood Village  
- **Faction**: "my old gang, the Shadow Runners" → Faction named Shadow Runners
- **Event**: "ever since the incident at the academy" → Event (the incident)
- **Relationship**: "my rival from training days" → NPC with rival relationship
- **Ability**: "using the technique my master taught me" → Ability reference, NPC (master)

## 2. VALIDATION

Check each entity against the rules:

### Canon Conflicts (check canon_cast_mode)
- **full_cast**: Players CANNOT claim blood/close relation to canon characters
  - ❌ "I'm Naruto's brother" → REJECT
  - ✓ "I trained at the same academy as Naruto" → ACCEPT (loose connection OK)
- **replaced_protagonist**: Player IS the protagonist, but cannot contradict major canon
- **npcs_only**: Canon characters are background only
- **inspired**: No canon restrictions

### Power Creep (check power_tier for tier imbalance)

**Power Tier Reference (VS Battles scale):**
- T10: Human (athletes, trained fighters, civilian baseline)
- T9: Superhuman (wall/street level, early shonen protagonists)
- T8: Urban (building to city-block destruction)
- T7: Nuclear (town to mountain-busting, Hashira/Jounin level)
- T6: Tectonic (island to continent, Admirals/Gojo tier)
- T5: Substellar (moon to planet destruction, Saitama/peak DBZ)
- T4: Stellar (star to solar system destruction)
- T3: Cosmic (galaxy to universe scale)
- T2: Multiversal (spacetime, infinite universes)
- T1: Higher Infinity (outerverse, beyond dimensions)
- T0: Boundless (true omnipotence)

**Each tier represents an ENORMOUS power gap.** Items/abilities must tier-match:
- **Same tier** = ACCEPT (a T8 character with a T8-capable weapon is fine)
- **1-tier difference** = needs_clarification (ask for backstory justification)
- **2+ tier gap** = REJECT (a T10 character CANNOT claim a T8 weapon)

Examples:
- ✓ T10 character: "my father's old hunting knife" (mundane, T10)
- ⚠️ T10 character: "a blade blessed by a minor spirit" (T9) → ask clarification
- ❌ T10 character: "the legendary demon-slaying sword" (T7-6 Hashira-level) → reject

### Narrative Consistency
- Does this contradict previously established facts?
- Is this suspiciously convenient? (sudden powerful ally, perfect item)
- Multiple new entities per turn = suspicious

## 3. DECISION

- **accepted**: The assertion is valid, create the entities
- **needs_clarification**: Ask the player to elaborate (suspicious but not outright wrong)
- **rejected**: Explain IN CHARACTER why this doesn't work

## OUTPUT

For each entity, provide:
- entity_type: npc, item, location, faction, event, ability, relationship
- name: The entity name
- details: {role, description, properties} as relevant
- implied_backstory: Any history implied
- is_new: True if creating, False if referencing existing

If rejecting/clarifying, provide a natural in-character response, not a robotic error."""
    
    async def call(
        self,
        player_input: str,
        character_context: str = "",
        canonicality: Dict[str, str] = None,
        power_tier: str = "T10",
        established_facts: str = "",
        **kwargs
    ) -> WorldBuildingOutput:
        """Call the world builder with context.
        
        Args:
            player_input: The player's action text
            character_context: Summary of the character
            canonicality: Dict with timeline_mode, canon_cast_mode, event_fidelity
            power_tier: Character's power tier (T1-T10)
            established_facts: Summary of established world facts
        """
        canonicality = canonicality or {}
        
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

---

Extract and validate any world-building assertions in this player action."""
        
        return await super().call(context_message)
