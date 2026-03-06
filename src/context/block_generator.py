"""
Context Block Generator for AIDM v3.

Generates and updates living prose summaries (context blocks) for narrative
elements: arcs, threads, quests, NPCs, and factions.

Runs on a fast model — blocks are generated in the background and must never
block a player-facing turn. All methods are fire-and-forget compatible.
"""

import json
import logging
from typing import Any

from pydantic import BaseModel, Field

from ..llm import get_llm_manager
from ..prompts import get_registry

logger = logging.getLogger(__name__)

# Use compactor as the agent name — same fast tier, same background role
_AGENT_NAME = "compactor"


class BlockOutput(BaseModel):
    """LLM output for a context block generation call."""
    content: str = Field(
        description="Prose narrative summary (continuity supervisor voice, 1200-1500 tokens max)"
    )
    continuity_checklist: dict = Field(
        default_factory=lambda: {"entities": [], "last_generated_turn": 0},
        description="Structured entity checklist for continuity enforcement"
    )


class ContextBlockGenerator:
    """
    Generates and updates context blocks via LLM.

    Each `generate_*` method accepts source material and an optional
    `existing_block` dict (for updates vs. fresh creation).
    Returns (content: str, continuity_checklist: dict).
    """

    def __init__(self) -> None:
        manager = get_llm_manager()
        self._provider, self._model = manager.get_provider_for_agent(_AGENT_NAME)
        self._system_prompt = get_registry().get_content("context_block_generator", fallback="")

    async def _generate(self, user_message: str) -> tuple[str, dict] | None:
        """Call the LLM and return (content, continuity_checklist) or None on failure."""
        try:
            result: BlockOutput = await self._provider.complete_with_schema(
                messages=[{"role": "user", "content": user_message}],
                schema=BlockOutput,
                system=self._system_prompt,
                model=self._model,
                max_tokens=4096,
            )
            return result.content, result.continuity_checklist
        except Exception:
            logger.exception("ContextBlockGenerator._generate failed")
            return None

    # ── Source material helpers ───────────────────────────────────────────────

    @staticmethod
    def _turns_section(turns: list[dict]) -> str:
        if not turns:
            return ""
        lines = [f"Turn {t.get('turn_number', '?')}: {t.get('narrative', t.get('content', ''))}" for t in turns]
        return "## Turn Narratives\n" + "\n\n".join(lines)

    @staticmethod
    def _memories_section(memories: list[dict]) -> str:
        if not memories:
            return ""
        lines = [m.get("content", "") for m in memories if m.get("content")]
        return "## Relevant Memories\n" + "\n".join(f"- {l}" for l in lines)

    @staticmethod
    def _existing_section(block: dict | None) -> str:
        if not block:
            return ""
        return (
            f"## Existing Block (version {block.get('version', 1)})\n"
            f"Last updated turn: {block.get('last_updated_turn', '?')}\n\n"
            f"{block.get('content', '')}"
        )

    # ── Public API ────────────────────────────────────────────────────────────

    async def generate_arc_block(
        self,
        arc_name: str,
        turn_narratives: list[dict],
        existing_block: dict | None = None,
    ) -> tuple[str, dict] | None:
        """Generate or update an arc block."""
        sections = [
            f"## Block Type: arc\n## Entity: {arc_name}",
            self._existing_section(existing_block),
            self._turns_section(turn_narratives),
        ]
        msg = "\n\n".join(s for s in sections if s)
        return await self._generate(msg)

    async def generate_thread_block(
        self,
        seed: dict,
        relevant_turns: list[dict] | None = None,
        memories: list[dict] | None = None,
        existing_block: dict | None = None,
    ) -> tuple[str, dict] | None:
        """Generate or update a foreshadowing thread block."""
        seed_summary = (
            f"Seed ID: {seed.get('id', seed.get('seed_id', '?'))}\n"
            f"Description: {seed.get('description', '')}\n"
            f"Status: {seed.get('status', '')}\n"
            f"Related NPCs: {', '.join(seed.get('related_npcs', []))}\n"
            f"Planted turn: {seed.get('planted_turn', '?')}"
        )
        sections = [
            f"## Block Type: thread\n## Entity: {seed.get('description', seed.get('id', seed.get('seed_id', '?')))}",
            f"## Seed Record\n{seed_summary}",
            self._existing_section(existing_block),
            self._memories_section(memories or []),
            self._turns_section(relevant_turns or []),
        ]
        msg = "\n\n".join(s for s in sections if s)
        return await self._generate(msg)

    async def generate_quest_block(
        self,
        quest: dict,
        relevant_turns: list[dict],
        existing_block: dict | None = None,
    ) -> tuple[str, dict] | None:
        """Generate or update a quest block."""
        objectives = quest.get("objectives", [])
        obj_lines = "\n".join(
            f"  - [{o.get('status', '?')}] {o.get('description', '')}" for o in objectives
        )
        quest_summary = (
            f"Quest: {quest.get('title', quest.get('id', '?'))}\n"
            f"Status: {quest.get('status', '')}\n"
            f"Giver: {quest.get('giver_npc', '')}\n"
            f"Created turn: {quest.get('created_turn', '?')}\n"
            f"Objectives:\n{obj_lines}"
        )
        sections = [
            f"## Block Type: quest\n## Entity: {quest.get('title', quest.get('id', '?'))}",
            f"## Quest Record\n{quest_summary}",
            self._existing_section(existing_block),
            self._turns_section(relevant_turns),
        ]
        msg = "\n\n".join(s for s in sections if s)
        return await self._generate(msg)

    async def generate_npc_block(
        self,
        npc: dict,
        memories: list[dict],
        relevant_turns: list[dict],
        existing_block: dict | None = None,
    ) -> tuple[str, dict] | None:
        """Generate or update an NPC block."""
        npc_summary = (
            f"Name: {npc.get('name', '?')}\n"
            f"Affinity: {npc.get('affinity', npc.get('affinity_score', 0))}\n"
            f"Scene count: {npc.get('scene_count', 0)}\n"
            f"Personality: {npc.get('personality', '')}\n"
            f"Secrets: {npc.get('secrets', '')}\n"
            f"Milestones: {json.dumps(npc.get('emotional_milestones', npc.get('milestones', [])))}"
        )
        sections = [
            f"## Block Type: npc\n## Entity: {npc.get('name', '?')}",
            f"## NPC Record\n{npc_summary}",
            self._existing_section(existing_block),
            self._memories_section(memories),
            self._turns_section(relevant_turns),
        ]
        msg = "\n\n".join(s for s in sections if s)
        return await self._generate(msg)

    async def generate_faction_block(
        self,
        faction: dict,
        memories: list[dict],
        relevant_turns: list[dict],
        existing_block: dict | None = None,
    ) -> tuple[str, dict] | None:
        """Generate or update a faction block."""
        faction_summary = (
            f"Name: {faction.get('name', '?')}\n"
            f"Influence score: {faction.get('influence_score', 0)}\n"
            f"PC is member: {faction.get('pc_is_member', False)}\n"
            f"Relationships: {json.dumps(faction.get('relationships', {}))}"
        )
        sections = [
            f"## Block Type: faction\n## Entity: {faction.get('name', '?')}",
            f"## Faction Record\n{faction_summary}",
            self._existing_section(existing_block),
            self._memories_section(memories),
            self._turns_section(relevant_turns),
        ]
        msg = "\n\n".join(s for s in sections if s)
        return await self._generate(msg)
