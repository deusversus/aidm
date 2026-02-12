"""'Previously On...' Recap Agent (#18).

Generates anime-style session-opening recaps from:
- arc_history entries (from Versioned Campaign Bible #2)
- Top narrative_beat memories (from ChromaDB)
- Current director_notes

Runs on a fast model (Haiku/Flash). Triggered on turn 1 of a session
or when the gap between sessions exceeds a threshold.

Design: ~800 input tokens, ~200 output tokens → ~150ms on Haiku.
"""

from typing import Optional
from pydantic import BaseModel, Field
from .base import BaseAgent


class RecapOutput(BaseModel):
    """Structured recap for session opening."""
    
    recap_text: str = Field(
        description=(
            "3-5 sentence anime-style 'Previously On...' recap. "
            "Dramatic, evocative, present-tense. Covers key events, "
            "emotional beats, and current stakes."
        )
    )
    key_threads: list[str] = Field(
        default_factory=list,
        description="2-4 active story threads the player should be aware of"
    )


class RecapAgent(BaseAgent):
    """Session-opening recap generator.
    
    Produces a dramatic 'Previously On...' paragraph that catches the
    player up on the story so far. Uses arc_history (Campaign Bible)
    and narrative_beat memories for source material.
    """
    
    agent_name = "recap"
    
    @property
    def output_schema(self):
        return RecapOutput
    
    @property
    def system_prompt(self) -> str:
        return """You are a recap narrator for an anime TTRPG narrative engine.

Generate a dramatic "Previously On..." recap that catches the player up on their story.

## Rules
1. Write 3-5 sentences in present tense, like an anime narrator doing a recap.
2. Hit the EMOTIONAL beats — what mattered, not just what happened.
3. End on the current tension/stakes to set up THIS session.
4. Reference specific character names, locations, and events from the provided context.
5. Tone should match the arc: dramatic for action arcs, wistful for emotional arcs, ominous for dark arcs.
6. key_threads: List 2-4 active story threads as brief phrases (e.g., "Belial's true identity", "the crumbling alliance").

## Style
Think: the narration at the start of an anime episode.
- "Last time, [protagonist] faced [challenge]..."
- "As [event] unfolds, [consequence] looms..."
- "The [situation] reaches a critical point as [tension]..."

Do NOT be generic. Be SPECIFIC to the events provided."""

    async def generate_recap(
        self,
        arc_history: list[dict],
        narrative_beats: list[str],
        director_notes: str,
        current_situation: str,
        character_name: str,
        arc_phase: str,
    ) -> Optional[RecapOutput]:
        """Generate a session-opening recap.
        
        Args:
            arc_history: List of arc_history entries from Campaign Bible
            narrative_beats: Top narrative_beat memories by heat
            director_notes: Current director guidance
            current_situation: Current WorldState situation
            character_name: Player character name
            arc_phase: Current arc phase
            
        Returns:
            RecapOutput or None on failure
        """
        # Build context from arc_history
        history_text = ""
        if arc_history:
            for i, entry in enumerate(arc_history[-5:]):  # Last 5 entries
                if isinstance(entry, dict):
                    history_text += f"Arc Event {i+1}: {entry.get('summary', str(entry))}\n"
                else:
                    history_text += f"Arc Event {i+1}: {entry}\n"
        
        # Build context from narrative beats
        beats_text = ""
        if narrative_beats:
            for i, beat in enumerate(narrative_beats[:5]):  # Top 5
                beats_text += f"Beat {i+1}: {beat}\n"
        
        try:
            result = await self.call(
                f"Generate a recap for {character_name}'s story so far.",
                arc_history=history_text or "(No arc history yet)",
                narrative_beats=beats_text or "(No narrative beats yet)",
                director_notes=director_notes or "(No director notes)",
                current_situation=current_situation,
                arc_phase=arc_phase,
            )
            return result
        except Exception as e:
            print(f"[RecapAgent] Recap generation failed (non-fatal): {e}")
            return None
