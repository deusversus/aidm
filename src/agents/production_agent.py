"""
Production Agent — post-narrative fire-and-forget reactor.

Runs AFTER KeyAnimator on every turn inside _post_narrative_processing.
Reads the completed narrative + context and uses tools to:

  Phase 2:  quest objective tracking, location discovery
  Phase 4:  media generation triggers (trigger_cutscene, generate_npc_portrait, generate_location_visual)

Design:
  - AgenticAgent (tool-calling) — not structured output.
  - Fast model (Haiku/Flash) — throughput over quality.
  - Fire-and-forget — failures are logged, never crash the pipeline.
  - Input: narrative, intent summary, outcome, active quests, pacing directive.
  - Output: free-form reasoning (discarded) + tool side-effects.
"""

import logging

from .base import AgenticAgent

logger = logging.getLogger(__name__)

class ProductionAgent(AgenticAgent):
    """Post-narrative reactor.  Reads the completed turn and takes actions.

    Responsibilities:
      - Quest tracking: detect objective completions, update quest status
      - Location discovery: extract locations, call upsert_location / set_current_location
      - Media generation: trigger cutscenes, NPC portraits, location visuals (when enabled)
    """

    agent_name = "production"
    prompt_name = "production"

    @property
    def output_schema(self):
        """Not used — ProductionAgent uses call_with_tools() (free-form text), not call() (structured)."""
        return None

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def react(
        self,
        narrative: str,
        player_input: str,
        intent_summary: str,
        outcome_summary: str,
        active_quests: str = "",
        pacing_note: str = "",
        situation: str = "",
        current_location: str = "",
    ) -> str | None:
        """Run post-narrative reaction pass.

        Args:
            narrative:       The DM narrative just generated.
            player_input:    What the player said/did.
            intent_summary:  Classified intent (e.g. "COMBAT: Attack the guard").
            outcome_summary: Outcome judge result summary.
            active_quests:   Pre-formatted active quest list (from get_active_quests tool).
            pacing_note:     Pacing directive note, if available.
            situation:       Current situation from WorldState.
            current_location: Player's current location name.

        Returns:
            Agent reasoning text (discarded by caller) or None on failure.
        """
        message = (
            f"## Narrative Just Generated\n\n{narrative}\n\n"
            f"---\n\n"
            f"## Turn Context\n"
            f"- **Player action:** {player_input}\n"
            f"- **Intent:** {intent_summary}\n"
            f"- **Outcome:** {outcome_summary}\n"
            f"- **Current location:** {current_location or '(unknown)'}\n"
            f"- **Situation:** {situation or '(unknown)'}\n"
        )
        if pacing_note:
            message += f"- **Pacing note:** {pacing_note}\n"

        message += (
            f"\n---\n\n"
            f"## Active Quests\n\n{active_quests or '(none yet)'}\n\n"
            f"---\n\n"
            f"Analyze the narrative and take any appropriate actions using your tools."
        )

        try:
            result = await self.call_with_tools(
                message,
                max_tool_rounds=3,
            )
            return result
        except Exception as e:
            logger.error(f"Reaction failed (non-fatal): {e}")
            return None

