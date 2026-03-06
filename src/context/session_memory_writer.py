"""
SessionMemoryWriter — writes end-of-session prose summaries for KA and Director.

Both writes are fire-and-forget async tasks fired at session close.
Results are saved to `planning_data['voice_journal']` and
`planning_data['director_session_memo']` on CampaignBible so they
are available at the next session startup.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


class SessionMemoryWriter:
    """Writes end-of-session KA voice journal and Director session memo."""

    async def write_voice_journal(
        self,
        campaign_id: int,
        recent_narrative: str,
        meta_feedback: str,
        profile_name: str,
        existing_journal: str = "",
    ) -> str | None:
        """Write a KA style annotation capturing session voice calibration.

        Returns the new journal text, or None on failure.
        """
        try:
            from ..llm.manager import get_llm_manager
            from ..core.prompt_registry import get_registry

            registry = get_registry()
            manager = get_llm_manager()
            provider = manager.get_provider_for_agent("compactor")

            system_prompt = (
                "You are the voice calibration system for an AI narrator. "
                "Write a short style annotation (max 300 words) capturing: "
                "the prose register used this session, recurring imagery, "
                "phrases that landed well, tone calibration notes from player feedback, "
                "and any voice adjustments to carry forward. "
                "Write in second person, e.g. 'Your prose this session favored...'"
            )

            user_msg = ""
            if existing_journal:
                user_msg += f"Previous voice journal:\n{existing_journal}\n\n"
            user_msg += f"Campaign profile: {profile_name}\n\n"
            if meta_feedback:
                user_msg += f"Player feedback this session:\n{meta_feedback}\n\n"
            if recent_narrative:
                user_msg += f"Sample narrative from this session (last 1000 chars):\n{recent_narrative[-1000:]}\n"

            response = await provider.complete(
                messages=[{"role": "user", "content": user_msg}],
                system=system_prompt,
                max_tokens=400,
            )
            return response.content.strip() if response and response.content else None
        except Exception:
            logger.exception("[SessionMemoryWriter] write_voice_journal failed")
            return None

    async def write_director_memo(
        self,
        campaign_id: int,
        arc_phase: str,
        current_arc: str,
        director_notes: str,
        active_seeds: list[dict],
        npc_spotlight_debt: list[dict],
        planning_data: dict,
    ) -> str | None:
        """Write a structured Director session memo.

        Returns the memo text, or None on failure.
        """
        try:
            from ..llm.manager import get_llm_manager

            manager = get_llm_manager()
            provider = manager.get_provider_for_agent("compactor")

            system_prompt = (
                "You are a narrative continuity director. "
                "Write a concise session memo (max 400 words) covering: "
                "arc position and momentum, seeds ready for payoff, "
                "NPCs who deserve a spotlight scene, creative decisions made this session, "
                "and open threads to carry forward. "
                "Use headers: Arc Status, Ready Payoffs, NPC Spotlight Debt, Carry Forward."
            )

            seeds_text = ""
            for s in active_seeds[:8]:
                seeds_text += f"- {s.get('description', '?')} [{s.get('status', '?')}]\n"

            npc_text = ""
            for n in npc_spotlight_debt[:5]:
                npc_text += f"- {n.get('name', '?')} (scenes: {n.get('scene_count', 0)})\n"

            user_msg = f"Arc: {current_arc} | Phase: {arc_phase}\n"
            user_msg += f"Director notes: {director_notes or 'None'}\n\n"
            if seeds_text:
                user_msg += f"Active foreshadowing seeds:\n{seeds_text}\n"
            if npc_text:
                user_msg += f"NPCs with unresolved spotlight debt:\n{npc_text}\n"

            response = await provider.complete(
                messages=[{"role": "user", "content": user_msg}],
                system=system_prompt,
                max_tokens=500,
            )
            return response.content.strip() if response and response.content else None
        except Exception:
            logger.exception("[SessionMemoryWriter] write_director_memo failed")
            return None
