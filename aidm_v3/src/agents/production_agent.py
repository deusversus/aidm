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
- Provide vivid visual_tags, atmosphere, and lighting for media generation.
- Extract location details FROM the narrative — don't invent details not described.

### 3. Media Generation (if media tools are available)
- **Cutscenes** (`trigger_cutscene`): Only for MAJOR cinematic moments — not every turn.
  - Good triggers: power awakenings, action climaxes, emotional peaks, dramatic reveals, plot twists.
  - Bad triggers: walking through a hallway, regular dialogue, mundane activities.
  - Aim for ~20% of turns at most. Quality over quantity.
  - Write VERY specific, detailed image prompts. Reference character appearances, expressions, lighting.
  - Motion prompts should be simple: camera movements, subtle character motion, environmental effects.
- **NPC Portraits** (`generate_npc_portrait`): When a NEW NPC is vividly described in the narrative for the first time.
  - Only call if the NPC has appearance data (visual_tags or appearance dict) in the database.
  - Don't call for minor unnamed NPCs. Focus on named characters with narrative importance.
- **Location Visuals** (`generate_location_visual`): When the player arrives at an important new location.
  - Only after you've called `upsert_location` with rich visual metadata.
  - Don't generate for every doorway — focus on dramatic reveals and significant destinations.

## Rules
1. Read the narrative carefully. Only take actions supported by what actually happened.
2. It's fine to take NO actions if nothing quest/location/media-relevant occurred.
3. Call get_active_quests BEFORE trying to complete objectives (you need the IDs).
4. Be precise with quest_id and objective_index — wrong IDs corrupt game state.
5. For locations, prefer specific names over generic ones ("The Rusty Anchor Tavern" not "a tavern").
6. Keep your reasoning brief — you run on a fast model and your text output is discarded.
7. Media generation is fire-and-forget — results appear asynchronously, don't wait for them."""
