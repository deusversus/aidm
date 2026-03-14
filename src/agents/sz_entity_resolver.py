"""SZ Entity Resolver Agent — deduplication and canonicalization pass.

Receives raw extraction output from one or more passes, merges duplicate
entities, builds the canonical entity graph and alias map.
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .session_zero_schemas import EntityResolutionOutput, ExtractionPassOutput


class SZEntityResolverAgent(BaseAgent):
    """Deduplicate and canonicalize extracted Session Zero entities."""

    agent_name = "sz_entity_resolver"
    prompt_name = "sz_entity_resolver"

    @property
    def output_schema(self):
        return EntityResolutionOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def resolve(
        self,
        extraction_passes: list[ExtractionPassOutput],
        character_draft: dict,
        profile_context: str | None = None,
    ) -> EntityResolutionOutput:
        """Resolve all extraction passes into a canonical entity graph.

        Args:
            extraction_passes:  All ExtractionPassOutput objects from the extractor
            character_draft:    The CharacterDraft.to_dict() from the current session
            profile_context:    Brief narrative profile summary

        Returns:
            EntityResolutionOutput with merged, deduplicated entities
        """
        # Serialize passes compactly to stay within token budget
        passes_json = [
            json.loads(p.model_dump_json()) for p in extraction_passes
        ]
        payload = {
            "extraction_passes": passes_json,
            "character_draft": character_draft,
            "profile_context": profile_context or "",
        }
        return await self.call(json.dumps(payload, ensure_ascii=False))
