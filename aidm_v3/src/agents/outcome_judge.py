"""Outcome Judge Agent - Determine if an action succeeds and how dramatically."""

from pydantic import BaseModel, Field
from typing import Literal, Optional, Dict
from .base import BaseAgent


class OutcomeOutput(BaseModel):
    """Structured output for outcome judgment."""
    
    should_succeed: bool = Field(
        description="Final verdict based on roll vs DC"
    )
    difficulty_class: int = Field(
        description="The target number (DC) for the action"
    )
    modifiers: Dict[str, int] = Field(
        description="Map of modifiers applied (e.g., {'High Ground': 2})"
    )
    calculated_roll: int = Field(
        description="The simulated total roll (d20 + mods)"
    )
    success_level: Literal["failure", "partial", "success", "critical"] = Field(
        description="Degree of success or failure"
    )
    narrative_weight: Literal["minor", "significant", "climactic"] = Field(
        description="How much narrative attention this deserves"
    )
    cost: Optional[str] = Field(
        default=None,
        description="What does success cost? (resource, consequence, complication)"
    )
    consequence: Optional[str] = Field(
        default=None,
        description="What happens as a result? (physical, emotional, plot)"
    )
    reasoning: str = Field(
        description="Brief explanation including the math (Roll vs DC)"
    )
    target_tier: Optional[str] = Field(
        default=None,
        description="Power tier of the target (e.g., 'T8') - used for combat imbalance calculations"
    )


class OutcomeJudge(BaseAgent):
    """Determine if an action succeeds and how dramatically."""
    
    agent_name = "outcome_judge"
    
    @property
    def output_schema(self):
        return OutcomeOutput
    
    @property
    def system_prompt(self) -> str:
        with open("prompts/outcome_judge.md", "r", encoding="utf-8") as f:
            return f.read()
