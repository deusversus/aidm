"""Turn dataclass for representing a completed turn."""

from dataclasses import dataclass
from typing import Any

from ..agents.intent_classifier import IntentOutput
from ..agents.outcome_judge import OutcomeOutput


@dataclass
class Turn:
    """Working object for a turn in progress."""
    input_text: str
    intent: IntentOutput | None = None
    outcome: OutcomeOutput | None = None
    narrative: str | None = None


@dataclass
class TurnResult:
    """Result of processing a single turn."""

    narrative: str
    intent: IntentOutput
    outcome: OutcomeOutput
    latency_ms: int
    cost_usd: float | None = None
    state_changes: dict[str, Any] | None = None
    portrait_map: dict[str, str] | None = None  # {"NPC Name": "/api/game/media/..."}
    turn_number: int | None = None
    campaign_id: int | None = None
