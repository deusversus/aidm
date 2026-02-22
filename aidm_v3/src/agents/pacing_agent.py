"""Pre-turn Pacing Agent - Lightweight Director micro-check (#1, #3).

Runs BEFORE KeyAnimator on every non-trivial turn. Uses a fast model
(Haiku/Flash) for structured extraction — reads Campaign Bible + WorldState
+ Intent and produces a PacingDirective that tells KeyAnimator how to
pace *this specific turn*.

#3 addition: Arc pacing gates with strength-tiered directives and
phase transition signals.

Design: ~1500 input tokens, ~250 output tokens → ~200ms on Haiku.
"""

import logging

from pydantic import BaseModel, Field

from .base import BaseAgent

logger = logging.getLogger(__name__)

class PacingDirective(BaseModel):
    """Structured pacing guidance for a single turn."""

    arc_beat: str = Field(
        description=(
            "Where this turn sits in the arc: "
            "'setup', 'rising', 'escalation', 'climax', 'falling', 'resolution', 'transition'"
        )
    )
    escalation_target: float = Field(
        ge=0, le=1,
        description="How much to escalate tension this turn (0.0=calm, 0.5=building, 1.0=peak)"
    )
    tone: str = Field(
        description=(
            "Primary tone for this turn: "
            "'dramatic', 'comedic', 'introspective', 'action', 'quiet', 'tense', 'bittersweet'"
        )
    )
    must_reference: list[str] = Field(
        default_factory=list,
        description="Elements the narrative MUST touch on (active threads, NPCs, promises)"
    )
    avoid: list[str] = Field(
        default_factory=list,
        description="Things to avoid this turn (premature reveals, tonal clashes)"
    )
    foreshadowing_hint: str = Field(
        default="",
        description="Optional: which foreshadowing seed to subtly weave in, if any"
    )
    pacing_note: str = Field(
        default="",
        description="One-line guidance for the Key Animator"
    )

    # #3: Arc pacing gates
    strength: str = Field(
        default="suggestion",
        description=(
            "How strongly this directive should be followed: "
            "'suggestion' (subtle guidance), 'strong' (explicit nudge), "
            "'override' (must follow — arc is stalling)"
        )
    )
    phase_transition: str = Field(
        default="",
        description=(
            "If non-empty, signals a phase transition the narrative should honor, "
            "e.g. 'rising → climax' or 'climax → falling'"
        )
    )


class PacingAgent(BaseAgent):
    """Pre-turn micro-check. Structured extraction on a fast model.
    
    NOT a full planning pass — reads existing Bible/WorldState context
    and classifies what THIS turn's pacing should be, given the player's
    intent. Runs in parallel with Outcome Judge and Memory Ranker.
    
    #3: Also evaluates arc gate conditions and escalates directive
    strength when phases stall.
    """

    agent_name = "pacing"
    prompt_name = "pacing"

    @property
    def output_schema(self):
        return PacingDirective

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def check(
        self,
        player_input: str,
        intent_summary: str,
        bible_notes: str,
        arc_phase: str,
        tension_level: float,
        situation: str,
        recent_summary: str,
        turns_in_phase: int = 0,
    ) -> PacingDirective | None:
        """Run the pre-turn pacing micro-check.
        
        Args:
            player_input: What the player said/did
            intent_summary: Classified intent (e.g., "COMBAT: Attack the guard")
            bible_notes: Director notes from Campaign Bible
            arc_phase: Current arc phase from WorldState
            tension_level: Current tension (0.0-1.0)
            situation: Current narrative situation
            recent_summary: Last 2-3 turn summaries
            turns_in_phase: How many turns in the current arc phase (#3)
            
        Returns:
            PacingDirective or None on failure
        """
        try:
            result = await self.call(
                player_input,
                intent_summary=intent_summary,
                current_arc_state=(
                    f"Phase: {arc_phase}, Tension: {tension_level:.1f}, "
                    f"Turns in phase: {turns_in_phase}"
                ),
                situation=situation,
                director_notes=bible_notes or "(No director notes yet)",
                recent_turns=recent_summary or "(First turns)",
            )
            return result
        except Exception as e:
            logger.error(f"Micro-check failed (non-fatal): {e}")
            return None
