"""Pre-turn Pacing Agent - Lightweight Director micro-check (#1, #3).

Runs BEFORE KeyAnimator on every non-trivial turn. Uses a fast model
(Haiku/Flash) for structured extraction — reads Campaign Bible + WorldState
+ Intent and produces a PacingDirective that tells KeyAnimator how to
pace *this specific turn*.

#3 addition: Arc pacing gates with strength-tiered directives and
phase transition signals.

Design: ~1500 input tokens, ~250 output tokens → ~200ms on Haiku.
"""

from typing import List, Optional
from pydantic import BaseModel, Field
from .base import BaseAgent


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
    must_reference: List[str] = Field(
        default_factory=list,
        description="Elements the narrative MUST touch on (active threads, NPCs, promises)"
    )
    avoid: List[str] = Field(
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
    
    @property
    def output_schema(self):
        return PacingDirective
    
    @property
    def system_prompt(self) -> str:
        return """You are a pacing analyst for an anime TTRPG narrative engine.

Given the current arc state and player's action, determine the optimal pacing for THIS TURN ONLY.

## Rules
1. Read the Campaign Bible / Director Notes to understand the current arc and planned beats.
2. Read the WorldState (tension, arc_phase, situation, turns_in_phase) for current narrative context.
3. Classify this turn's arc_beat based on where the story is AND what the player is doing:
   - "setup": Establishing setting, introductions, world-building
   - "rising": Building tension, complications emerging
   - "escalation": Tension increasing sharply, stakes becoming clear
   - "climax": Peak confrontation, decisive moments
   - "falling": Aftermath, consequences settling in
   - "resolution": Wrapping up threads, emotional payoff
   - "transition": Shifting between arcs or settings
4. Set escalation_target based on arc_beat:
   - setup/transition → 0.0-0.2
   - rising → 0.2-0.5
   - escalation → 0.5-0.8
   - climax → 0.8-1.0
   - falling → 0.3-0.5
   - resolution → 0.0-0.3
5. Choose tone to match the beat AND the player's intent.
6. must_reference: Only include elements that are NARRATIVELY DUE — don't force references.
7. avoid: Flag things that would break pacing.
8. pacing_note: One sentence of actionable guidance.
9. If the player is DERAILING the planned arc, acknowledge it — don't fight the player.

## Phase Gate Rules (#3)
Evaluate `turns_in_phase` to detect stalling arcs:

| Phase | Turns | Strength | Action |
|-------|-------|----------|--------|
| setup | > 6 | strong | Nudge toward rising — introduce a complication |
| setup | > 10 | override | Force transition to rising |
| rising | > 8 | strong | Begin escalation — raise stakes |
| rising | > 12 | override | Force escalation or climax |
| escalation | > 6 | strong | Push toward climax |
| escalation | > 10 | override | Force climax — tension must break |
| climax | > 4 | strong | Begin falling — let consequences land |
| climax | > 8 | override | Force falling — climax can't last forever |
| falling | > 6 | strong | Move to resolution |
| resolution | > 4 | strong | Transition to next arc |

- If tension_level > 0.8 for the current phase and phase is NOT climax, suggest climax transition with "strong".
- Default strength is "suggestion" when no gate fires.
- Set phase_transition to "current_phase → suggested_phase" when a gate fires (e.g., "rising → climax").
- NEVER set strength to "override" unless the gate thresholds above are met.

## Key Principle
The player drives the story. Gates prevent STALLING, not player agency. If the player is actively driving the story forward, gates are irrelevant — set strength to "suggestion" even if turns_in_phase is high."""

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
    ) -> Optional[PacingDirective]:
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
            print(f"[PacingAgent] Micro-check failed (non-fatal): {e}")
            return None
