"""Intent Classifier Agent - Parse player input into structured intent."""

from typing import Literal

from pydantic import BaseModel, Field

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
    target: str | None = Field(
        default=None,
        description="Who/what the action targets"
    )
    declared_epicness: float = Field(
        ge=0,
        le=1,
        description="How epic/dramatic the player intends this to be (0=mundane, 1=climactic)"
    )
    special_conditions: list[str] = Field(
        default_factory=list,
        description="Special flags: 'named_attack', 'power_of_friendship', 'underdog_moment', etc."
    )
    confidence: float = Field(
        ge=0, le=1, default=1.0,
        description="How confident this classification is (1.0=certain, <0.7=ambiguous)"
    )
    secondary_intent: INTENT_TYPES | None = Field(
        default=None,
        description="If confidence < 0.7, the next most likely intent category"
    )


class IntentClassifier(BaseAgent):
    """Parse player input into structured intent."""

    agent_name = "intent_classifier"
    prompt_name = "intent_classifier"

    @property
    def output_schema(self):
        return IntentOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

