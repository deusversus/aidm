"""Turn dataclass for representing a completed turn."""

from dataclasses import dataclass
from typing import Optional, Dict, Any

from ..agents.intent_classifier import IntentOutput
from ..agents.outcome_judge import OutcomeOutput


@dataclass
class Turn:
    """Working object for a turn in progress."""
    input_text: str
    intent: Optional[IntentOutput] = None
    outcome: Optional[OutcomeOutput] = None
    narrative: Optional[str] = None


@dataclass
class TurnResult:
    """Result of processing a single turn."""
    
    narrative: str
    intent: IntentOutput
    outcome: OutcomeOutput
    latency_ms: int
    cost_usd: Optional[float] = None
    state_changes: Optional[Dict[str, Any]] = None
