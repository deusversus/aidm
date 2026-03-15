"""Session Zero per-turn pipeline.

Wraps the existing SessionZeroAgent (conductor) with per-turn extraction,
entity resolution, and gap analysis.  Runs behind the
``SESSION_ZERO_ORCHESTRATOR_ENABLED`` feature flag.

When the flag is off, SessionZeroAgent handles all turns directly (legacy).
When on, each player turn triggers:

1. **Extraction** — ``SZExtractorAgent.extract_chunk()`` on the latest
   user message (plus a small context window)
2. **Entity resolution** — ``SZEntityResolverAgent.resolve()`` merging new
   extraction into the cumulative entity graph
3. **Gap analysis** — ``SZGapAnalyzerAgent.analyze()`` identifying missing
   info and recommending follow-up questions
4. **Conductor** — ``SessionZeroAgent.process_turn()`` with gap context
   injected so it can pick smarter follow-ups

The cumulative entity graph is persisted to ``session_zero_artifacts``
(type ``sz_entity_graph``) after every turn so the pipeline can resume
after a server restart.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from src.agents.session_zero_schemas import (
    EntityResolutionOutput,
    ExtractionPassOutput,
    GapAnalysisOutput,
)
from src.agents.sz_extractor import SZExtractorAgent
from src.agents.sz_entity_resolver import SZEntityResolverAgent
from src.agents.sz_gap_analyzer import SZGapAnalyzerAgent

if TYPE_CHECKING:
    from src.agents.session_zero import SessionZeroAgent, SessionZeroOutput
    from src.core.session import Session

logger = logging.getLogger(__name__)


# ── Pipeline state ────────────────────────────────────────────────────────────

@dataclass
class SZPipelineState:
    """Accumulated state across all pipeline turns.

    Kept in memory during the session; persisted to ``session_zero_artifacts``
    after each turn for crash recovery (Phase 4).
    """
    extraction_passes: list[ExtractionPassOutput] = field(default_factory=list)
    entity_resolution: EntityResolutionOutput | None = None
    gap_analysis: GapAnalysisOutput | None = None
    turn_count: int = 0


# ── Pipeline ──────────────────────────────────────────────────────────────────

class SessionZeroPipeline:
    """Per-turn orchestration layer for Session Zero.

    Wraps the existing ``SessionZeroAgent`` (conductor) with extraction,
    resolution, and gap-analysis passes.  Does **not** subclass or modify
    the agent — it composes around it.

    Usage::

        pipeline = SessionZeroPipeline(conductor=agent)
        result = await pipeline.process_turn(session, player_input)
    """

    # How many recent messages to include in the extraction window
    EXTRACTION_CONTEXT_WINDOW = 6

    def __init__(
        self,
        conductor: SessionZeroAgent,
        *,
        session_id: str | None = None,
    ) -> None:
        self.conductor = conductor
        self.session_id = session_id

        # Sub-agents (instantiated lazily so settings are fresh)
        self._extractor = SZExtractorAgent()
        self._resolver = SZEntityResolverAgent()
        self._gap_analyzer = SZGapAnalyzerAgent()

        # Pipeline state
        self._state = SZPipelineState()

    # ── Public API ────────────────────────────────────────────────────────────

    async def process_turn(
        self,
        session: Session,
        player_input: str,
    ) -> SessionZeroOutput:
        """Run the full per-turn pipeline and return the conductor's response.

        Steps:
            1. Extract from latest turn (+ context window)
            2. Resolve entities incrementally
            3. Analyze gaps
            4. Generate conductor response with gap context
            5. Persist entity graph (for crash recovery)
        """
        self._state.turn_count += 1
        logger.info(
            "SZ pipeline turn %d — session=%s",
            self._state.turn_count,
            self.session_id or "unknown",
        )

        # ── Step 1: Extraction ────────────────────────────────────────────
        extraction = await self._run_extraction(session, player_input)
        if extraction:
            self._state.extraction_passes.append(extraction)

        # ── Step 2: Entity resolution ─────────────────────────────────────
        if self._state.extraction_passes:
            resolution = await self._run_entity_resolution(session)
            if resolution:
                self._state.entity_resolution = resolution

        # ── Step 3: Gap analysis ──────────────────────────────────────────
        if self._state.entity_resolution:
            gap = await self._run_gap_analysis(session)
            if gap:
                self._state.gap_analysis = gap

        # ── Step 4: Conductor response with gap context ───────────────────
        result = await self._run_conductor(session, player_input)

        # ── Step 5: Persist entity graph ──────────────────────────────────
        await self._persist_entity_graph(session)

        return result

    @property
    def state(self) -> SZPipelineState:
        """Current pipeline state (for inspection/testing)."""
        return self._state

    def restore_state(self, state: SZPipelineState) -> None:
        """Restore pipeline state from a previous checkpoint."""
        self._state = state

    # ── Step implementations ──────────────────────────────────────────────────

    async def _run_extraction(
        self,
        session: Session,
        player_input: str,
    ) -> ExtractionPassOutput | None:
        """Extract entities/facts from the latest turn."""
        try:
            from src.agents._session_zero_research import get_profile_context_for_agent

            messages = session.messages or []
            total = len(messages)

            # Build a small context window: last N messages + current input
            window_start = max(0, total - self.EXTRACTION_CONTEXT_WINDOW)
            chunk = [
                {"role": m["role"], "content": m["content"]}
                for m in messages[window_start:]
            ]
            # Add the current player input as the newest message
            chunk.append({"role": "user", "content": player_input})

            # Previously extracted IDs for dedup
            prev_ids = []
            if self._state.entity_resolution:
                prev_ids = [
                    e.canonical_id
                    for e in self._state.entity_resolution.canonical_entities
                ]

            profile_context = get_profile_context_for_agent(session)

            result = await self._extractor.extract_chunk(
                transcript_chunk=chunk,
                chunk_start_index=window_start,
                chunk_end_index=total + 1,
                previously_extracted_canonical_ids=prev_ids,
                profile_context=profile_context,
            )
            logger.info(
                "SZ extraction: %d entities, %d facts, %d relationships",
                len(result.entity_records),
                len(result.fact_records),
                len(result.relationship_records),
            )
            return result

        except Exception:
            logger.exception("SZ extraction failed — continuing without new extraction")
            return None

    async def _run_entity_resolution(
        self,
        session: Session,
    ) -> EntityResolutionOutput | None:
        """Merge all extraction passes into a canonical entity graph."""
        try:
            from src.agents._session_zero_research import get_profile_context_for_agent

            result = await self._resolver.resolve(
                extraction_passes=self._state.extraction_passes,
                character_draft=session.character_draft.to_dict(),
                profile_context=get_profile_context_for_agent(session),
            )
            logger.info(
                "SZ entity resolution: %d canonical entities, %d merges",
                len(result.canonical_entities),
                len(result.merges_performed),
            )
            return result

        except Exception:
            logger.exception("SZ entity resolution failed — using prior graph")
            return None

    async def _run_gap_analysis(
        self,
        session: Session,
    ) -> GapAnalysisOutput | None:
        """Identify gaps and recommend follow-up questions."""
        try:
            result = await self._gap_analyzer.analyze(
                entity_resolution=self._state.entity_resolution,
                extraction_passes=self._state.extraction_passes,
                character_draft=session.character_draft.to_dict(),
                session_messages_count=len(session.messages or []),
            )
            logger.info(
                "SZ gap analysis: handoff_safe=%s, %d unresolved, %d followups recommended",
                result.handoff_safe,
                len(result.unresolved_items),
                len(result.recommended_player_followups),
            )
            return result

        except Exception:
            logger.exception("SZ gap analysis failed — continuing with default progression")
            return None

    async def _run_conductor(
        self,
        session: Session,
        player_input: str,
    ) -> SessionZeroOutput:
        """Run the conductor (existing SZ agent) with gap context injected."""
        return await self.conductor.process_turn(
            session,
            player_input,
            gap_context=self._build_gap_context(),
        )

    # ── Gap context formatting ────────────────────────────────────────────────

    def _build_gap_context(self) -> str | None:
        """Format gap analysis results for injection into conductor prompt."""
        gap = self._state.gap_analysis
        if not gap:
            return None

        parts = []

        if gap.recommended_player_followups:
            parts.append("## Recommended Follow-Up Questions (from gap analysis)")
            for i, q in enumerate(gap.recommended_player_followups[:5], 1):
                parts.append(f"{i}. {q}")

        if gap.unresolved_items:
            parts.append(f"\n## Unresolved Items: {len(gap.unresolved_items)}")
            for item in gap.unresolved_items[:3]:
                parts.append(f"- [{item.priority}] {item.description}")

        if gap.contradictions:
            parts.append(f"\n## Contradictions Detected: {len(gap.contradictions)}")
            for c in gap.contradictions[:2]:
                parts.append(f"- {c.issue_type.value}: {'; '.join(c.statements[:2])}")

        if gap.blocking_issues:
            parts.append(f"\n## Blocking Issues: {', '.join(gap.blocking_issues)}")

        entity_summary = self._build_entity_summary()
        if entity_summary:
            parts.append(entity_summary)

        return "\n".join(parts) if parts else None

    def _build_entity_summary(self) -> str | None:
        """One-line summary of the entity graph for the conductor."""
        er = self._state.entity_resolution
        if not er:
            return None
        n_entities = len(er.canonical_entities)
        n_rels = len(er.canonical_relationships)
        return (
            f"\n## Entity Graph Summary: {n_entities} canonical entities, "
            f"{n_rels} relationships"
        )

    # ── Persistence ───────────────────────────────────────────────────────────

    async def _persist_entity_graph(self, session: Session) -> None:
        """Save the entity graph to session_zero_artifacts for crash recovery."""
        if not self._state.entity_resolution or not self.session_id:
            return

        try:
            from src.db.session import get_session
            from src.db.session_zero_artifacts import save_artifact

            db = get_session()
            try:
                save_artifact(
                    db,
                    self.session_id,
                    "sz_entity_graph",
                    self._state.entity_resolution,
                )
                db.commit()
                logger.debug("SZ entity graph persisted for session %s", self.session_id)
            finally:
                db.close()

        except Exception:
            logger.exception("Failed to persist entity graph — non-fatal")

    def load_prior_entity_graph(self, session_id: str) -> bool:
        """Attempt to restore entity graph from artifacts. Returns True if restored."""
        try:
            from src.db.session import get_session
            from src.db.session_zero_artifacts import (
                get_active_artifact,
                load_artifact_content,
            )

            db = get_session()
            try:
                artifact = get_active_artifact(db, session_id, "sz_entity_graph")
                if artifact:
                    self._state.entity_resolution = load_artifact_content(
                        artifact, EntityResolutionOutput
                    )
                    self.session_id = session_id
                    logger.info(
                        "Restored entity graph from artifact v%d for session %s",
                        artifact.version,
                        session_id,
                    )
                    return True
            finally:
                db.close()

        except Exception:
            logger.exception("Failed to restore entity graph — starting fresh")

        return False
