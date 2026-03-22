"""SZ Extractor Agent — first pass of the Session Zero Handoff Compiler.

Reads a chunk of the SZ transcript and extracts all narratively significant
entities, relationships, facts, and opening-scene cues.
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .session_zero_schemas import ExtractionPassOutput


class SZExtractorAgent(BaseAgent):
    """Extract entities, facts, and cues from a Session Zero transcript chunk."""

    agent_name = "sz_extractor"
    prompt_name = "sz_extractor"
    cache_system_prompt = True

    @property
    def output_schema(self):
        return ExtractionPassOutput

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    async def extract_chunk(
        self,
        transcript_chunk: list[dict],
        chunk_start_index: int,
        chunk_end_index: int,
        previously_extracted_canonical_ids: list[str] | None = None,
        profile_context: str | None = None,
    ) -> ExtractionPassOutput:
        """Run extraction over a single transcript chunk.

        Args:
            transcript_chunk:                    Message slice [{role, content}]
            chunk_start_index:                   Position of first message in full transcript
            chunk_end_index:                     Position after last message (exclusive)
            previously_extracted_canonical_ids:  IDs already extracted in prior passes
            profile_context:                     Brief narrative profile summary

        Returns:
            ExtractionPassOutput with all extracted records
        """
        payload = {
            "transcript_chunk": transcript_chunk,
            "chunk_start_index": chunk_start_index,
            "chunk_end_index": chunk_end_index,
            "previously_extracted_canonical_ids": previously_extracted_canonical_ids or [],
            "profile_context": profile_context or "",
        }
        return await self.call(json.dumps(payload, ensure_ascii=False))
