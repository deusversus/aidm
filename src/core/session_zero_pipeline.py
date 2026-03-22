"""Session Zero per-turn pipeline.

Wraps the existing SessionZeroAgent (conductor) with per-turn extraction,
entity resolution + gap analysis, memory retrieval, and compaction.
Runs behind the ``SESSION_ZERO_ORCHESTRATOR_ENABLED`` feature flag.

When the flag is off, SessionZeroAgent handles all turns directly (legacy).
When on, each player turn triggers:

1. **Extraction** — ``SZExtractorAgent.extract_chunk()`` on the latest
   user message (plus a small context window)
2. **Resolution + Gap Analysis** — ``SZResolverAndGapAgent.resolve_and_analyze()``
   merging the latest extraction into the entity graph incrementally AND
   identifying gaps/contradictions in a single pass
3. **Validation** — consistency check on resolution output (retry once if
   extraction found entities but resolution returned zero)
4. **Memory retrieval** — pgvector queries for prior SZ context (no LLM call)
5. **Compaction** — summarize dropped messages via CompactorAgent
6. **Conductor** — ``SessionZeroAgent.process_turn()`` with gap context,
   retrieved memories, and compaction text injected

The cumulative entity graph is persisted to ``session_zero_artifacts``
(type ``sz_entity_graph``) after every turn so the pipeline can resume
after a server restart.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from src.agents.session_zero_schemas import (
    EntityResolutionOutput,
    ExtractionPassOutput,
    GapAnalysisOutput,
    ResolverAndGapOutput,
)
from src.agents.sz_extractor import SZExtractorAgent
from src.agents.sz_resolver_and_gap import SZResolverAndGapAgent
from src.observability import end_trace, log_span, start_trace

if TYPE_CHECKING:
    from src.agents.session_zero import SessionZeroAgent, SessionZeroOutput
    from src.context.memory import MemoryStore
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
    compaction_text: str = ""
    last_compacted_index: int = 0


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

    # Messages in the conductor's sliding window before compaction kicks in
    COMPACTION_THRESHOLD = 30

    def __init__(
        self,
        conductor: SessionZeroAgent,
        *,
        session_id: str | None = None,
        memory_store: MemoryStore | None = None,
    ) -> None:
        self.conductor = conductor
        self.session_id = session_id
        self._memory_store = memory_store

        # Sub-agents (instantiated lazily so settings are fresh)
        self._extractor = SZExtractorAgent()
        self._resolver_and_gap = SZResolverAndGapAgent()

        # Pipeline state
        self._state = SZPipelineState()

    # ── Public API ────────────────────────────────────────────────────────────

    async def process_turn(
        self,
        session: Session,
        player_input: str,
    ) -> SessionZeroOutput:
        """Run the full per-turn pipeline and return the conductor's response.

        Steps (parallel where possible):
            1. [Extraction ‖ Gap analysis(prior state)] — run in parallel
            2. Entity resolution (needs extraction output)
            3. Validation — consistency check on resolution (retry once if needed)
            4. Memory retrieval — pgvector search for prior SZ context (no LLM)
            5. Compaction — summarize dropped messages if window exceeded
            6. Conductor response — with gap context + memories + compaction
            7. Persist pipeline state — entity graph + metadata

        The entire pipeline runs inside a ``TurnTokenBudget`` context.
        If any step exceeds the configured token limits, a
        ``TokenBudgetExceeded`` error is raised and the turn aborts.
        """
        from src.config import Config
        from src.observability import TurnTokenBudget

        self._state.turn_count += 1
        logger.info(
            "SZ pipeline turn %d — session=%s",
            self._state.turn_count,
            self.session_id or "unknown",
        )

        start_trace(
            "sz_process_turn",
            session_id=self.session_id,
            metadata={"turn_count": self._state.turn_count},
            tags=[f"session:{self.session_id}"] if self.session_id else [],
            input=player_input,
        )

        max_in, max_out, max_calls = Config.get_turn_limits()
        async with TurnTokenBudget(
            max_input=max_in,
            max_output=max_out,
            max_calls=max_calls,
        ) as budget:
            # ── Step 1: Extraction ────────────────────────────────────────
            extraction = await self._run_extraction(session, player_input)
            if extraction:
                self._state.extraction_passes.append(extraction)

            # ── Step 2: Resolution + Gap Analysis (merged, incremental) ───
            # Sends only the LATEST extraction + prior graph (O(1), not O(n))
            if extraction:
                combined = await self._run_resolution_and_gap(session, extraction)
                if combined:
                    self._state.entity_resolution = combined.as_entity_resolution()
                    self._state.gap_analysis = combined.as_gap_analysis()

            # ── Step 3: Validation — retry if inconsistent ────────────────
            if extraction and self._state.entity_resolution:
                await self._validate_resolution(session, extraction)

            # ── Step 4: Memory retrieval (no LLM call) ────────────────────
            retrieved_memories = self._run_memory_retrieval(
                player_input, extraction
            )

            # ── Step 5: Compaction ────────────────────────────────────────
            await self._run_compaction(session)

            # ── Step 6: Conductor response with enriched context ──────────
            result = await self._run_conductor(
                session, player_input, retrieved_memories
            )

            # ── Step 7: Persist pipeline state ────────────────────────────
            await self._persist_pipeline_state(session)

            logger.info(
                "SZ pipeline turn %d complete — %d calls, %d input tokens, %d output tokens",
                self._state.turn_count,
                budget.call_count,
                budget.accumulated_input,
                budget.accumulated_output,
            )

        end_trace(
            output={
                "phase": getattr(session, "phase", None) and session.phase.value,
                "ready_for_gameplay": result.ready_for_gameplay,
            },
            metadata={
                "calls": budget.call_count,
                "input_tokens": budget.accumulated_input,
                "output_tokens": budget.accumulated_output,
            },
        )

        return result

    @property
    def state(self) -> SZPipelineState:
        """Current pipeline state (for inspection/testing)."""
        return self._state

    def restore_state(self, state: SZPipelineState) -> None:
        """Restore pipeline state from a previous checkpoint."""
        self._state = state

    def build_extraction_summary(self) -> dict | None:
        """Build extraction summary dict for SessionZeroResponse."""
        if not self._state.extraction_passes:
            return None

        latest = self._state.extraction_passes[-1]
        gap = self._state.gap_analysis
        er = self._state.entity_resolution

        return {
            "entity_count": len(er.canonical_entities) if er else 0,
            "fact_count": len(latest.fact_records),
            "relationship_count": len(er.canonical_relationships) if er else 0,
            "unresolved_count": len(gap.unresolved_items) if gap else 0,
            "handoff_safe": gap.handoff_safe if gap else None,
            "turn_count": self._state.turn_count,
        }

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
            log_span(
                "sz_pipeline.extraction",
                input={"chunk_start": window_start, "chunk_end": total + 1},
                output={
                    "entity_count": len(result.entity_records),
                    "fact_count": len(result.fact_records),
                    "relationship_count": len(result.relationship_records),
                },
            )
            return result

        except Exception:
            logger.exception("SZ extraction failed — continuing without new extraction")
            return None

    async def _run_resolution_and_gap(
        self,
        session: Session,
        latest_extraction: ExtractionPassOutput,
    ) -> ResolverAndGapOutput | None:
        """Resolve entities and analyze gaps in a single merged pass.

        Sends only the LATEST extraction + prior entity graph (incremental,
        O(1) input size instead of O(n) with turn count).
        """
        try:
            from src.agents._session_zero_research import get_profile_context_for_agent

            result = await self._resolver_and_gap.resolve_and_analyze(
                latest_extraction=latest_extraction,
                character_draft=session.character_draft.to_dict(),
                session_messages_count=len(session.messages or []),
                prior_resolution=self._state.entity_resolution,
                profile_context=get_profile_context_for_agent(session),
            )
            logger.info(
                "SZ resolve+gap: %d entities, %d merges, handoff_safe=%s, %d unresolved",
                len(result.canonical_entities),
                len(result.merges_performed),
                result.handoff_safe,
                len(result.unresolved_items),
            )
            log_span(
                "sz_pipeline.resolution_and_gap",
                output={
                    "canonical_entity_count": len(result.canonical_entities),
                    "merges_performed": len(result.merges_performed),
                    "alias_count": len(result.alias_map),
                    "handoff_safe": result.handoff_safe,
                    "unresolved_count": len(result.unresolved_items),
                    "blocking_issues": result.blocking_issues,
                    "top_followups": result.recommended_player_followups[:3],
                },
            )
            return result

        except Exception:
            logger.exception("SZ resolution+gap failed — using prior state")
            return None

    async def _run_conductor(
        self,
        session: Session,
        player_input: str,
        retrieved_memories: list[dict[str, Any]] | None = None,
    ) -> SessionZeroOutput:
        """Run the conductor (existing SZ agent) with enriched context."""
        result = await self.conductor.process_turn(
            session,
            player_input,
            gap_context=self._build_gap_context(retrieved_memories),
        )
        log_span(
            "sz_pipeline.conductor",
            input={"has_gap_context": self._state.gap_analysis is not None},
            output={
                "phase": getattr(session, "phase", None) and session.phase.value,
                "ready_for_gameplay": result.ready_for_gameplay,
            },
        )
        return result

    # ── Memory retrieval (no LLM call) ─────────────────────────────────────

    def _run_memory_retrieval(
        self,
        player_input: str,
        extraction: ExtractionPassOutput | None,
    ) -> list[dict[str, Any]]:
        """Search prior SZ memories for relevant context. Zero LLM calls."""
        if not self._memory_store:
            return []

        try:
            # Query 1: semantic match against player input
            results = self._memory_store.search(
                player_input, limit=3, boost_on_access=False
            )

            # Query 2: entity name keyword search (if extraction found entities)
            if extraction and extraction.entity_records:
                for entity in extraction.entity_records[:3]:
                    name = entity.display_name
                    hybrid_results = self._memory_store.search_hybrid(
                        query=name, keyword=name, limit=2,
                        boost_on_access=False,
                    )
                    results.extend(hybrid_results)

            # Dedup by content prefix
            seen: dict[str, dict] = {}
            for mem in results:
                key = mem.get("content", "")[:100]
                existing = seen.get(key)
                if not existing or mem.get("score", 0) > existing.get("score", 0):
                    seen[key] = mem

            final = sorted(
                seen.values(), key=lambda m: m.get("score", 0), reverse=True
            )[:5]

            if final:
                log_span(
                    "sz_pipeline.memory_retrieval",
                    output={"memory_count": len(final)},
                )
            return final

        except Exception:
            logger.exception("SZ memory retrieval failed — continuing without")
            return []

    # ── Compaction ─────────────────────────────────────────────────────────

    async def _run_compaction(self, session: Session) -> None:
        """Summarize dropped messages when the transcript exceeds the window."""
        messages = session.messages or []
        total = len(messages)

        if total <= self.COMPACTION_THRESHOLD:
            return

        # Only compact messages that are newly dropped since last compaction
        new_drop_end = total - self.COMPACTION_THRESHOLD
        if new_drop_end <= self._state.last_compacted_index:
            return  # Already compacted up to this point

        dropped = messages[self._state.last_compacted_index:new_drop_end]
        if not dropped:
            return

        try:
            from src.agents.compactor import CompactorAgent

            compactor = CompactorAgent()
            summary = await compactor.compact(
                dropped_messages=dropped,
                prior_context=self._state.compaction_text,
            )
            self._state.compaction_text += f"\n{summary}" if self._state.compaction_text else summary
            self._state.last_compacted_index = new_drop_end

            log_span(
                "sz_pipeline.compaction",
                output={
                    "messages_compacted": len(dropped),
                    "compaction_length": len(self._state.compaction_text),
                },
            )
            logger.info(
                "SZ compaction: summarized %d dropped messages",
                len(dropped),
            )

        except Exception:
            logger.exception("SZ compaction failed — continuing without summary")

    # ── Resolution validation ──────────────────────────────────────────────

    async def _validate_resolution(
        self,
        session: Session,
        extraction: ExtractionPassOutput,
    ) -> None:
        """Retry resolution once if extraction found entities but resolution returned zero."""
        resolution = self._state.entity_resolution
        if not resolution:
            return

        extracted_count = len(extraction.entity_records)
        resolved_count = len(resolution.canonical_entities)

        if extracted_count > 0 and resolved_count == 0:
            logger.warning(
                "SZ validation: extraction found %d entities but resolution returned 0 — retrying",
                extracted_count,
            )
            log_span(
                "sz_pipeline.resolution_retry",
                input={"extracted_count": extracted_count},
            )
            retry = await self._run_resolution_and_gap(session, extraction)
            if retry and len(retry.canonical_entities) > 0:
                self._state.entity_resolution = retry.as_entity_resolution()
                self._state.gap_analysis = retry.as_gap_analysis()
                logger.info(
                    "SZ resolution retry succeeded: %d canonical entities",
                    len(retry.canonical_entities),
                )

    # ── Gap context formatting ────────────────────────────────────────────────

    def _build_gap_context(
        self,
        retrieved_memories: list[dict[str, Any]] | None = None,
    ) -> str | None:
        """Format gap analysis + memories + compaction for conductor prompt."""
        parts = []

        # Compaction text (accumulated summaries of dropped messages)
        if self._state.compaction_text:
            parts.append("## Prior Conversation Summary")
            parts.append(self._state.compaction_text)

        # Retrieved memories from prior SZ turns
        if retrieved_memories:
            parts.append("\n## Relevant Prior Context (from memory)")
            for mem in retrieved_memories:
                content = mem.get("content", "")[:200]
                parts.append(f"- {content}")

        # Gap analysis
        gap = self._state.gap_analysis
        if gap:
            if gap.recommended_player_followups:
                parts.append("\n## Recommended Follow-Up Questions (from gap analysis)")
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

    async def _persist_pipeline_state(self, session: Session) -> None:
        """Save entity graph and pipeline metadata for crash recovery."""
        if not self.session_id:
            return

        try:
            from src.db.session import get_session
            from src.db.session_zero_artifacts import save_artifact

            with get_session() as db:
                # Persist entity graph (for entity resolution recovery)
                if self._state.entity_resolution:
                    save_artifact(
                        db,
                        self.session_id,
                        "sz_entity_graph",
                        self._state.entity_resolution,
                    )

                # Persist pipeline metadata (turn count, extraction pass count)
                from pydantic import BaseModel as _BM

                class _PipelineMeta(_BM):
                    turn_count: int = 0
                    extraction_pass_count: int = 0
                    compaction_text: str = ""
                    last_compacted_index: int = 0

                save_artifact(
                    db,
                    self.session_id,
                    "sz_pipeline_meta",
                    _PipelineMeta(
                        turn_count=self._state.turn_count,
                        extraction_pass_count=len(self._state.extraction_passes),
                        compaction_text=self._state.compaction_text,
                        last_compacted_index=self._state.last_compacted_index,
                    ),
                )

                logger.debug("SZ pipeline state persisted for session %s", self.session_id)

        except Exception:
            logger.exception("Failed to persist pipeline state — non-fatal")

    def load_prior_state(self, session_id: str) -> bool:
        """Attempt to restore pipeline state from artifacts. Returns True if restored."""
        try:
            from src.db.session import get_session
            from src.db.session_zero_artifacts import (
                get_active_artifact,
                load_artifact_content,
            )

            with get_session() as db:
                restored = False

                # Restore entity graph
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
                    restored = True

                # Restore pipeline metadata (turn count)
                meta_artifact = get_active_artifact(db, session_id, "sz_pipeline_meta")
                if meta_artifact:
                    meta = json.loads(meta_artifact.content) if isinstance(meta_artifact.content, str) else meta_artifact.content
                    self._state.turn_count = meta.get("turn_count", 0)
                    self._state.compaction_text = meta.get("compaction_text", "")
                    self._state.last_compacted_index = meta.get("last_compacted_index", 0)
                    logger.info(
                        "Restored pipeline meta: turn_count=%d for session %s",
                        self._state.turn_count,
                        session_id,
                    )
                    restored = True

                return restored

        except Exception:
            logger.exception("Failed to restore pipeline state — starting fresh")

        return False

    # Backward-compatible alias
    load_prior_entity_graph = load_prior_state
