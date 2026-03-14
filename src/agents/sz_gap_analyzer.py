"""SZ Gap Analyzer Agent — quality-assurance pass of the Handoff Compiler.

Receives the resolved entity graph and extraction output, then identifies
gaps, contradictions, and ambiguities that need resolution before handoff.
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .session_zero_schemas import (
    EntityResolutionOutput,
    ExtractionPassOutput,
    GapAnalysisOutput,
)


class SZGapAnalyzerAgent(BaseAgent):
    """Identify narrative gaps, contradictions, and handoff blockers."""

    agent_name = "sz_gap_analyzer"
    prompt_name = "sz_gap_analyzer"

    @property
    def output_schema(self):
        return GapAnalysisOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def analyze(
        self,
        entity_resolution: EntityResolutionOutput,
        extraction_passes: list[ExtractionPassOutput],
        character_draft: dict,
        session_messages_count: int,
        minimum_viable_fields: list[str] | None = None,
    ) -> GapAnalysisOutput:
        """Run gap analysis against the resolved entity graph.

        Args:
            entity_resolution:      Output from SZEntityResolverAgent.resolve()
            extraction_passes:      Raw extraction passes for full context
            character_draft:        CharacterDraft.to_dict()
            session_messages_count: Total number of messages in the SZ conversation
            minimum_viable_fields:  Required fields for safe handoff (uses defaults if None)

        Returns:
            GapAnalysisOutput with gaps, contradictions, and handoff verdict
        """
        passes_json = [
            json.loads(p.model_dump_json()) for p in extraction_passes
        ]
        payload = {
            "entity_resolution": json.loads(entity_resolution.model_dump_json()),
            "extraction_passes": passes_json,
            "character_draft": character_draft,
            "session_messages_count": session_messages_count,
            "minimum_viable_fields": minimum_viable_fields or [
                "player_character.name",
                "player_character.concept",
                "opening_situation.starting_location",
            ],
        }
        return await self.call(json.dumps(payload, ensure_ascii=False))
