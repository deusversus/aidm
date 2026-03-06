"""'Previously On...' Recap Agent (#18).

Generates anime-style session-opening recaps from:
- arc_history entries (from Versioned Campaign Bible #2)
- Top narrative_beat memories (from ChromaDB)
- Current director_notes

Runs on a fast model (Haiku/Flash). Triggered on turn 1 of a session
or when the gap between sessions exceeds a threshold.

Design: ~800 input tokens, ~200 output tokens → ~150ms on Haiku.
"""

import logging

from pydantic import BaseModel, Field

from .base import BaseAgent

logger = logging.getLogger(__name__)

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
    prompt_name = "recap"

    @property
    def output_schema(self):
        return RecapOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def generate_recap(
        self,
        arc_history: list[dict],
        narrative_beats: list[str],
        director_notes: str,
        current_situation: str,
        character_name: str,
        arc_phase: str,
        recent_narrative: str = "",
        arc_blocks: list[dict] | None = None,
    ) -> RecapOutput | None:
        """Generate a session-opening recap.

        Args:
            arc_history: List of arc_history entries from Campaign Bible
            narrative_beats: Top narrative_beat memories by heat
            director_notes: Current director guidance
            current_situation: Current WorldState situation
            character_name: Player character name
            arc_phase: Current arc phase
            recent_narrative: Actual story text from recent turns (primary source)

        Returns:
            RecapOutput or None on failure
        """
        # Build context from arc blocks (richer than raw arc_history)
        blocks_text = ""
        if arc_blocks:
            for block in arc_blocks:
                blocks_text += f"[{block.get('block_type', 'arc').upper()} — {block.get('entity_name', '')}]\n{block.get('content', '')}\n\n"

        # Build context from arc_history (metadata only — not primary source)
        history_text = blocks_text  # prefer blocks over raw history when available
        if not blocks_text and arc_history:
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

        # If there's nothing at all to recap, bail early
        has_content = bool(recent_narrative or beats_text or history_text)
        if not has_content:
            logger.info("Recap skipped: no story content available yet")
            return None

        try:
            result = await self.call(
                f"Generate a recap for {character_name}'s story so far.",
                recent_narrative=recent_narrative or None,
                arc_history=history_text or None,
                narrative_beats=beats_text or None,
                director_notes=director_notes or None,
                current_situation=current_situation,
                arc_phase=arc_phase,
            )
            return result
        except Exception as e:
            logger.error(f"Recap generation failed (non-fatal): {e}")
            return None
