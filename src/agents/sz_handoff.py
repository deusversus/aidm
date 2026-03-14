"""SZ Handoff Agent — final assembly pass of the Handoff Compiler.

Receives the resolved entity graph, gap analysis, and character draft,
then produces the authoritative OpeningStatePackage for Director + KA.
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .session_zero_schemas import (
    EntityResolutionOutput,
    GapAnalysisOutput,
    OpeningSceneCue,
    OpeningStatePackage,
)


class SZHandoffAgent(BaseAgent):
    """Assemble the final OpeningStatePackage from all compiler pass outputs."""

    agent_name = "sz_handoff"
    prompt_name = "sz_handoff"

    @property
    def output_schema(self):
        return OpeningStatePackage

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def assemble(
        self,
        entity_resolution: EntityResolutionOutput,
        gap_analysis: GapAnalysisOutput,
        character_draft: dict,
        profile_context: str | None = None,
        opening_cues: list[OpeningSceneCue] | None = None,
        tone_composition: dict | None = None,
        session_messages_count: int = 0,
    ) -> OpeningStatePackage:
        """Assemble the OpeningStatePackage from all compiler pass outputs.

        Args:
            entity_resolution:      Output from SZEntityResolverAgent.resolve()
            gap_analysis:           Output from SZGapAnalyzerAgent.analyze()
            character_draft:        CharacterDraft.to_dict()
            profile_context:        Brief narrative profile summary
            opening_cues:           Aggregated OpeningSceneCue list from all extraction passes
            tone_composition:       Campaign narrative composition settings dict
            session_messages_count: Total SZ message count

        Returns:
            OpeningStatePackage — the complete handoff contract
        """
        cues_json = [
            json.loads(c.model_dump_json()) for c in (opening_cues or [])
        ]
        payload = {
            "entity_resolution": json.loads(entity_resolution.model_dump_json()),
            "gap_analysis": json.loads(gap_analysis.model_dump_json()),
            "character_draft": character_draft,
            "profile_context": profile_context or "",
            "opening_cues": cues_json,
            "tone_composition": tone_composition or {},
            "session_messages_count": session_messages_count,
        }
        return await self.call(json.dumps(payload, ensure_ascii=False))
