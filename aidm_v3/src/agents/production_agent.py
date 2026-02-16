"""
Production Agent — post-narrative fire-and-forget reactor.

Runs AFTER KeyAnimator on every turn inside _post_narrative_processing.
Reads the completed narrative + context and uses tools to:

  Phase 2  (now):   quest objective tracking, location discovery
  Phase 4  (later): media generation triggers (trigger_cutscene, generate_location_visual)

Design:
  - AgenticAgent (tool-calling) — not structured output.
  - Fast model (Haiku/Flash) — throughput over quality.
  - Fire-and-forget — failures are logged, never crash the pipeline.
  - Input: narrative, intent summary, outcome, active quests, pacing directive.
  - Output: free-form reasoning (discarded) + tool side-effects.
"""

from typing import Optional
from .base import AgenticAgent


class ProductionAgent(AgenticAgent):
    """Post-narrative reactor.  Reads the completed turn and takes actions.

    Responsibilities (Phase 2):
      - Quest tracking: detect objective completions, update quest status
      - Location discovery: extract locations, call upsert_location / set_current_location

    Future (Phase 4):
      - Media triggers: classify cinematic moments, fire media generation
    """

    agent_name = "production"

    @property
    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

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
    ) -> Optional[str]:
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
            print(f"[ProductionAgent] Reaction failed (non-fatal): {e}")
            return None


# ---------------------------------------------------------------------------
# System prompt — kept as module constant for readability
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are the Production Agent for an anime TTRPG narrative engine.

You run AFTER the narrative has been written. Your job is to REACT to what just happened by updating the game's tracking systems.

## Your Responsibilities

### 1. Quest Tracking
- Call `get_active_quests` to see what quests exist.
- If the narrative shows a quest objective being accomplished, call `complete_quest_objective`.
- If ALL objectives of a quest are done OR the quest's goal is clearly achieved, call `update_quest_status` with "completed".
- If the narrative shows a quest becoming impossible, call `update_quest_status` with "failed".
- Do NOT create quests — that's the Director's job.
- Be CONSERVATIVE: only update quests when the narrative CLEARLY shows progress.

### 2. Location Discovery
- If the narrative mentions a NEW named location, call `upsert_location` with rich visual details.
- If the player has MOVED to a different location, call `set_current_location`.
- Provide vivid visual_tags, atmosphere, and lighting for media generation later.
- Extract location details FROM the narrative — don't invent details not described.

## Rules
1. Read the narrative carefully. Only take actions supported by what actually happened.
2. It's fine to take NO actions if nothing quest/location-relevant occurred.
3. Call get_active_quests BEFORE trying to complete objectives (you need the IDs).
4. Be precise with quest_id and objective_index — wrong IDs corrupt game state.
5. For locations, prefer specific names over generic ones ("The Rusty Anchor Tavern" not "a tavern").
6. Keep your reasoning brief — you run on a fast model and your text output is discarded."""

