"""Outcome Judge Agent - Determine if an action succeeds and how dramatically."""

from typing import Literal

from pydantic import BaseModel, Field

from .base import BaseAgent


class OutcomeOutput(BaseModel):
    """Structured output for outcome judgment."""

    should_succeed: bool = Field(
        description="Final verdict based on roll vs DC"
    )
    difficulty_class: int = Field(
        description="The target number (DC) for the action"
    )
    modifiers: dict[str, int] = Field(
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
    cost: str | None = Field(
        default=None,
        description="ONLY set for dramatic/risky actions — null for routine power use or actions within character capability. Most actions should have no cost."
    )
    consequence: str | None = Field(
        default=None,
        description="ONLY set for significant narrative turning points — null for routine actions. An OP character casting a basic spell has NO consequence."
    )
    consequence_category: Literal["political", "environmental", "relational", "economic", "magical"] | None = Field(
        default=None,
        description="Category of the consequence if one exists. political=alliances/authority/governance. environmental=terrain/destruction/weather. relational=trust/betrayal/reputation. economic=wealth/trade/debt. magical=curses/enchantments/power shifts. Null if no consequence."
    )
    reasoning: str = Field(
        description="Brief explanation including the math (Roll vs DC)"
    )
    target_tier: str | None = Field(
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
        with open("prompts/outcome_judge.md", encoding="utf-8") as f:
            return f.read()
