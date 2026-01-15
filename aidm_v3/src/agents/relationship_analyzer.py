"""RelationshipAnalyzer Agent - Detect NPC relationship changes after each turn."""

from pydantic import BaseModel, Field
from typing import Optional, Literal, List
from .base import BaseAgent


class RelationshipOutput(BaseModel):
    """Structured output for relationship analysis."""
    
    npc_name: str = Field(
        description="Name of the NPC being analyzed"
    )
    affinity_delta: int = Field(
        ge=-10, 
        le=10,
        description="Change in affinity this turn (-10 to +10). 0 = neutral interaction."
    )
    emotional_milestone: Optional[Literal[
        "first_humor",       # Laughed together
        "first_concern",     # NPC showed genuine worry for PC
        "first_disagreement",# Had a real argument
        "first_initiative",  # NPC acted independently to help
        "first_sacrifice",   # NPC took a hit for PC
        "first_vulnerability",# NPC shared deep fear/secret
        "first_trust_test"   # PC could have betrayed but didn't
    ]] = Field(
        default=None,
        description="Emotional milestone if one occurred (only 'firsts' count)"
    )
    reasoning: str = Field(
        description="Brief explanation of why this affinity change/milestone was detected"
    )


class BatchRelationshipOutput(BaseModel):
    """Batch output for analyzing multiple NPCs in one call."""
    results: List[RelationshipOutput] = Field(
        description="List of relationship analysis results, one per NPC"
    )


class RelationshipAnalyzer(BaseAgent):
    """Analyze NPC relationship changes from narrative context.
    
    Fast, lightweight agent for detecting:
    - Affinity changes (-10 to +10 per turn)
    - Emotional milestones (first_humor, first_sacrifice, etc.)
    
    Supports both single-NPC and batch-NPC analysis.
    Uses fast model tier - DO NOT add to EXTENDED_THINKING_AGENTS.
    """
    
    agent_name = "relationship_analyzer"
    
    @property
    def output_schema(self):
        return RelationshipOutput
    
    @property
    def system_prompt(self) -> str:
        return """You are an NPC relationship analyzer for an anime TTRPG.

Analyze the interaction between the player and the NPC to determine:

1. **AFFINITY DELTA** (-10 to +10):
   - +5 to +10: Major positive (saved their life, shared vulnerability, loyal defense)
   - +1 to +4: Minor positive (friendly chat, small help, humor)
   - 0: Neutral (transactional, no emotional content)
   - -1 to -4: Minor negative (dismissed them, minor insult, ignored)
   - -5 to -10: Major negative (betrayal, attack, humiliation)

2. **EMOTIONAL MILESTONES** (only if this is the FIRST time):
   - first_humor: They laughed together genuinely
   - first_concern: NPC showed real worry for PC's wellbeing
   - first_disagreement: Had a real argument (can still be positive growth)
   - first_initiative: NPC independently helped without being asked
   - first_sacrifice: NPC took damage/risk to protect PC
   - first_vulnerability: NPC shared a deep secret or fear
   - first_trust_test: PC could have betrayed NPC but chose not to

Only mark a milestone if it CLEARLY happened in this interaction.
Be conservative - most interactions have no milestone."""

    async def analyze_batch(
        self,
        npc_names: List[str],
        action: str,
        outcome: str,
        narrative_excerpt: str
    ) -> List[RelationshipOutput]:
        """Analyze relationship changes for multiple NPCs in a single LLM call.
        
        Args:
            npc_names: List of NPC names present in the scene
            action: The player's action
            outcome: The outcome of the action
            narrative_excerpt: Excerpt from the generated narrative
            
        Returns:
            List of RelationshipOutput, one per NPC
        """
        if not npc_names:
            return []
        
        # Build NPC list for prompt
        npc_list = "\n".join([f"- {name}" for name in npc_names])
        
        prompt = f"""Analyze the following interaction for EACH NPC present.

PLAYER ACTION: {action}
OUTCOME: {outcome}

NARRATIVE:
{narrative_excerpt}

NPCS PRESENT:
{npc_list}

For EACH NPC listed above, determine their affinity change and any emotional milestone.
Return a result for every NPC, even if the delta is 0."""
        
        try:
            # Use batch schema
            provider, model = self._get_provider_and_model()
            response = await provider.complete_with_schema(
                messages=[{"role": "user", "content": prompt}],
                schema=BatchRelationshipOutput,
                system=self.system_prompt,
                model=model
            )
            return response.results
        except Exception as e:
            print(f"[RelationshipAnalyzer] Batch analysis failed: {e}, falling back to empty")
            return []

