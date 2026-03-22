"""SZ Resolver & Gap Analyzer — merged resolution + quality-assurance pass.

Replaces the separate SZEntityResolverAgent and SZGapAnalyzerAgent with a
single LLM call that builds the canonical entity graph AND immediately
evaluates it for gaps, contradictions, and handoff readiness.

Benefits:
- Eliminates one LLM call per turn (was 2, now 1)
- Removes the duplicated extraction_passes payload between the two agents
- Receives only the LATEST extraction pass + prior graph (incremental, O(1))
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .session_zero_schemas import (
    EntityResolutionOutput,
    ExtractionPassOutput,
    ResolverAndGapOutput,
)


class SZResolverAndGapAgent(BaseAgent):
    """Resolve entities and analyze gaps in a single pass."""

    agent_name = "sz_resolver_and_gap"
    prompt_name = "sz_resolver_and_gap"

    # Enable prompt caching — combined prompt is ~2,800 tokens,
    # well above Anthropic's 1,024-token cache threshold.
    cache_system_prompt = True

    @property
    def output_schema(self):
        return ResolverAndGapOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def resolve_and_analyze(
        self,
        latest_extraction: ExtractionPassOutput,
        character_draft: dict,
        session_messages_count: int,
        *,
        prior_resolution: EntityResolutionOutput | None = None,
        profile_context: str | None = None,
        minimum_viable_fields: list[str] | None = None,
    ) -> ResolverAndGapOutput:
        """Resolve the latest extraction into the entity graph and assess gaps.

        Args:
            latest_extraction:     The newest ExtractionPassOutput (this turn only)
            character_draft:       CharacterDraft.to_dict() from the current session
            session_messages_count: Total messages in the SZ conversation
            prior_resolution:      The EntityResolutionOutput from the previous turn,
                                   or None on turn 1 (build from scratch)
            profile_context:       Brief narrative profile summary
            minimum_viable_fields: Required fields for safe handoff

        Returns:
            ResolverAndGapOutput with merged entity graph + gap assessment
        """
        payload = {
            "latest_extraction": json.loads(latest_extraction.model_dump_json()),
            "prior_resolution": (
                json.loads(prior_resolution.model_dump_json())
                if prior_resolution is not None
                else None
            ),
            "character_draft": character_draft,
            "profile_context": profile_context or "",
            "session_messages_count": session_messages_count,
            "minimum_viable_fields": minimum_viable_fields or [
                "player_character.name",
                "player_character.concept",
                "opening_situation.starting_location",
            ],
        }
        return await self.call(json.dumps(payload, ensure_ascii=False))
