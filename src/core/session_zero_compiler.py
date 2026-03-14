"""Session Zero Handoff Compiler.

Orchestrates the multi-pass pipeline that transforms a completed Session Zero
conversation into a fully structured OpeningStatePackage.

Pipeline (from sz_upgrade_plan.md §8):
  1. Extraction Pass(es)  — SZExtractorAgent: entities, facts, cues from transcript
  2. Entity Resolution    — SZEntityResolverAgent: dedup + canonicalize entity graph
  3. Gap Analysis         — SZGapAnalyzerAgent: missing fields, contradictions, verdict
  4. Handoff Assembly     — SZHandoffAgent: assemble OpeningStatePackage

All four passes run sequentially. The compiler persists a versioned
SessionZeroArtifact after each successful run.

Usage:
    compiler = HandoffCompiler(session, character_draft, campaign_id=42)
    result = await compiler.run()
    if result.success:
        package = result.opening_state_package
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime

from ..agents.sz_entity_resolver import SZEntityResolverAgent
from ..agents.sz_extractor import SZExtractorAgent
from ..agents.sz_gap_analyzer import SZGapAnalyzerAgent
from ..agents.sz_handoff import SZHandoffAgent
from ..agents.session_zero_schemas import (
    ArtifactStatus,
    CompilerCheckpoint,
    CompilerRunType,
    EntityResolutionOutput,
    ExtractionPassOutput,
    GapAnalysisOutput,
    HandoffCompilerResult,
    HandoffStatus,
    OpeningSceneCue,
    OpeningStatePackage,
    PackageMetadata,
    PackageReadiness,
)
from ..db.session_zero_artifacts import (
    compute_draft_hash,
    compute_transcript_hash,
    fail_run,
    get_active_artifact,
    load_artifact_content,
    save_artifacts_transactional,
)
from ..db.session import get_session
from ..db.models import SessionZeroRun
from ..llm.manager import get_llm_manager

logger = logging.getLogger(__name__)

# Chunk size for transcript extraction passes (messages per chunk)
# Keeps each LLM call well within context window limits
_EXTRACTION_CHUNK_SIZE = 20


@dataclass
class CompilerContext:
    """Working state accumulated across compiler passes."""
    session_id: str
    campaign_id: int | None
    messages: list[dict]
    character_draft: dict
    profile_context: str
    tone_composition: dict = field(default_factory=dict)

    extraction_passes: list[ExtractionPassOutput] = field(default_factory=list)
    entity_resolution: EntityResolutionOutput | None = None
    gap_analysis: GapAnalysisOutput | None = None
    opening_package: OpeningStatePackage | None = None
    checkpoints: list[CompilerCheckpoint] = field(default_factory=list)

    transcript_hash: str = ""
    draft_hash: str = ""

    def aggregate_opening_cues(self) -> list[OpeningSceneCue]:
        cues: list[OpeningSceneCue] = []
        for p in self.extraction_passes:
            cues.extend(p.opening_scene_cues)
        return cues

    def extraction_stats(self) -> dict:
        entities = sum(len(p.entity_records) for p in self.extraction_passes)
        rels = sum(len(p.relationship_records) for p in self.extraction_passes)
        facts = sum(len(p.fact_records) for p in self.extraction_passes)
        return {"entities": entities, "relationships": rels, "facts": facts}


class HandoffCompiler:
    """Orchestrates the Session Zero handoff compilation pipeline.

    Designed to be instantiated once per handoff, not as a singleton.
    All agents are created fresh per run — provider/model config is
    resolved at instantiation time via LLMManager.

    Args:
        session_id:       UUID string for the Session Zero session
        messages:         Full session.messages list [{role, content}]
        character_draft:  CharacterDraft.to_dict() from the session
        campaign_id:      Integer campaign PK (set after campaign is created)
        profile_context:  Brief narrative profile summary for disambiguation
        tone_composition: Campaign narrative composition settings dict
        run_type:         One of 'handoff_compile', 'turn_orchestration', 'recovery_compile'
    """

    def __init__(
        self,
        session_id: str,
        messages: list[dict],
        character_draft: dict,
        campaign_id: int | None = None,
        profile_context: str = "",
        tone_composition: dict | None = None,
        run_type: str = CompilerRunType.HANDOFF_COMPILE,
    ):
        self.session_id = session_id
        self.run_type = run_type

        self._ctx = CompilerContext(
            session_id=session_id,
            campaign_id=campaign_id,
            messages=messages,
            character_draft=character_draft,
            profile_context=profile_context,
            tone_composition=tone_composition or {},
            transcript_hash=compute_transcript_hash(messages),
            draft_hash=compute_draft_hash(character_draft),
        )

        # Instantiate agents with their provider/model from settings
        mgr = get_llm_manager()
        self._extractor = self._make_agent(SZExtractorAgent, mgr)
        self._resolver = self._make_agent(SZEntityResolverAgent, mgr)
        self._gap_analyzer = self._make_agent(SZGapAnalyzerAgent, mgr)
        self._handoff_agent = self._make_agent(SZHandoffAgent, mgr)

    @staticmethod
    def _make_agent(agent_class, mgr):
        provider, model = mgr.get_provider_for_agent(agent_class.agent_name)
        return agent_class(provider=provider, model=model)

    async def run(self) -> HandoffCompilerResult:
        """Run the full compiler pipeline end-to-end.

        Returns:
            HandoffCompilerResult with success flag, package, and artifacts
        """
        from ..agents.progress import ProgressPhase, ProgressTracker

        tracker = ProgressTracker(total_steps=10)
        logger.info(
            "[HandoffCompiler] Starting %s for session=%s messages=%d (task_id=%s)",
            self.run_type, self.session_id, len(self._ctx.messages), tracker.task_id,
        )

        try:
            await tracker.emit(ProgressPhase.INITIALIZING, "Handoff compiler starting…", 5)

            # Pass 1: Extraction
            n_chunks = max(1, (len(self._ctx.messages) + _EXTRACTION_CHUNK_SIZE - 1) // _EXTRACTION_CHUNK_SIZE)
            await tracker.emit(ProgressPhase.PARSING, f"Pass 1: extracting facts ({n_chunks} chunk(s))…", 15)
            await self._run_extraction_pass()
            stats = self._ctx.extraction_stats()
            await tracker.emit(ProgressPhase.PARSING, f"Pass 1 done — {stats['entities']} entities, {stats['facts']} facts", 35)

            # Pass 2: Entity Resolution
            await tracker.emit(ProgressPhase.PARSING, "Pass 2: resolving entities…", 45)
            await self._run_entity_resolution_pass()
            n_canonical = len(self._ctx.entity_resolution.canonical_entities) if self._ctx.entity_resolution else 0
            await tracker.emit(ProgressPhase.PARSING, f"Pass 2 done — {n_canonical} canonical entities", 60)

            # Pass 3: Gap Analysis
            await tracker.emit(ProgressPhase.PARSING, "Pass 3: gap analysis…", 65)
            await self._run_gap_analysis_pass()
            n_gaps = len(self._ctx.gap_analysis.unresolved_items) if self._ctx.gap_analysis else 0
            await tracker.emit(ProgressPhase.PARSING, f"Pass 3 done — {n_gaps} gaps found", 75)

            # Pass 4: Handoff Assembly
            await tracker.emit(ProgressPhase.SAVING, "Pass 4: assembling opening-state package…", 80)
            await self._run_handoff_assembly_pass()

            # Persist all artifacts in a single transaction
            await tracker.emit(ProgressPhase.SAVING, "Persisting artifacts…", 90)
            run, saved = await self._persist_artifacts()

            await tracker.complete("Handoff compiler complete")

            package = self._ctx.opening_package
            return HandoffCompilerResult(
                success=True,
                opening_state_package=package,
                entity_graph=self._ctx.entity_resolution,
                gap_analysis=self._ctx.gap_analysis,
                checkpoints=self._ctx.checkpoints,
                artifact_version=saved.get("opening_state_package", {}).version if saved else None,
                run_id=run.id if run else None,
                warnings=self._ctx.gap_analysis.warnings if self._ctx.gap_analysis else [],
                compiler_task_id=tracker.task_id,
            )

        except Exception as exc:
            logger.exception("[HandoffCompiler] Pipeline failed for session=%s", self.session_id)
            try:
                await tracker.error(f"Compiler failed: {exc}")
            except Exception:
                pass
            return HandoffCompilerResult(
                success=False,
                checkpoints=self._ctx.checkpoints,
                error=str(exc),
                compiler_task_id=tracker.task_id,
            )

    # ──────────────────────────────────────────────────────────────────────
    # Pass implementations
    # ──────────────────────────────────────────────────────────────────────

    async def _run_extraction_pass(self) -> None:
        """Run extraction in chunks across the full transcript."""
        messages = self._ctx.messages
        chunk_size = _EXTRACTION_CHUNK_SIZE
        total = len(messages)
        all_canonical_ids: list[str] = []

        for chunk_start in range(0, total, chunk_size):
            chunk_end = min(chunk_start + chunk_size, total)
            chunk = messages[chunk_start:chunk_end]

            logger.debug(
                "[HandoffCompiler] Extraction chunk %d-%d / %d",
                chunk_start, chunk_end, total,
            )

            pass_output = await self._extractor.extract_chunk(
                transcript_chunk=chunk,
                chunk_start_index=chunk_start,
                chunk_end_index=chunk_end,
                previously_extracted_canonical_ids=all_canonical_ids,
                profile_context=self._ctx.profile_context,
            )
            self._ctx.extraction_passes.append(pass_output)

            # Track canonical IDs to avoid re-extraction in later chunks
            all_canonical_ids.extend(e.canonical_id for e in pass_output.entity_records)

        stats = self._ctx.extraction_stats()
        self._ctx.checkpoints.append(CompilerCheckpoint(
            checkpoint_id=f"extraction_{self.session_id[:8]}",
            pass_name="extraction",
            pass_sequence=1,
            entities_created=stats["entities"],
            next_step="entity_resolution",
        ))
        logger.info("[HandoffCompiler] Extraction complete: %s", stats)

    async def _run_entity_resolution_pass(self) -> None:
        """Merge and deduplicate all extracted entities."""
        self._ctx.entity_resolution = await self._resolver.resolve(
            extraction_passes=self._ctx.extraction_passes,
            character_draft=self._ctx.character_draft,
            profile_context=self._ctx.profile_context,
        )

        n_entities = len(self._ctx.entity_resolution.canonical_entities)
        n_merges = len(self._ctx.entity_resolution.merges_performed)
        self._ctx.checkpoints.append(CompilerCheckpoint(
            checkpoint_id=f"entity_resolution_{self.session_id[:8]}",
            pass_name="entity_resolution",
            pass_sequence=2,
            entities_created=n_entities,
            entities_merged=n_merges,
            next_step="gap_analysis",
        ))
        logger.info(
            "[HandoffCompiler] Entity resolution complete: %d canonical entities, %d merges",
            n_entities, n_merges,
        )

    async def _run_gap_analysis_pass(self) -> None:
        """Identify gaps, contradictions, and determine handoff readiness."""
        self._ctx.gap_analysis = await self._gap_analyzer.analyze(
            entity_resolution=self._ctx.entity_resolution,
            extraction_passes=self._ctx.extraction_passes,
            character_draft=self._ctx.character_draft,
            session_messages_count=len(self._ctx.messages),
        )

        n_gaps = len(self._ctx.gap_analysis.unresolved_items)
        n_contradictions = len(self._ctx.gap_analysis.contradictions)
        blocked = not self._ctx.gap_analysis.handoff_safe

        self._ctx.checkpoints.append(CompilerCheckpoint(
            checkpoint_id=f"gap_analysis_{self.session_id[:8]}",
            pass_name="gap_analysis",
            pass_sequence=3,
            unresolved_items_count=n_gaps,
            contradictions_detected=n_contradictions,
            handoff_blocked=blocked,
            warnings=self._ctx.gap_analysis.warnings,
            next_step="handoff_assembly" if not blocked else "BLOCKED",
        ))
        logger.info(
            "[HandoffCompiler] Gap analysis complete: %d gaps, %d contradictions, safe=%s",
            n_gaps, n_contradictions, not blocked,
        )

        if blocked:
            blocking = "; ".join(self._ctx.gap_analysis.blocking_issues)
            logger.warning("[HandoffCompiler] Handoff blocked: %s", blocking)

    async def _run_handoff_assembly_pass(self) -> None:
        """Assemble the final OpeningStatePackage."""
        package = await self._handoff_agent.assemble(
            entity_resolution=self._ctx.entity_resolution,
            gap_analysis=self._ctx.gap_analysis,
            character_draft=self._ctx.character_draft,
            profile_context=self._ctx.profile_context,
            opening_cues=self._ctx.aggregate_opening_cues(),
            tone_composition=self._ctx.tone_composition,
            session_messages_count=len(self._ctx.messages),
        )

        # Stamp metadata fields the agent can't know
        package.package_metadata.session_id = self.session_id
        package.package_metadata.campaign_id = self._ctx.campaign_id
        package.package_metadata.transcript_hash = self._ctx.transcript_hash
        package.package_metadata.character_draft_hash = self._ctx.draft_hash
        package.package_metadata.created_at = datetime.utcnow().isoformat()

        self._ctx.opening_package = package

        self._ctx.checkpoints.append(CompilerCheckpoint(
            checkpoint_id=f"handoff_assembly_{self.session_id[:8]}",
            pass_name="handoff_assembly",
            pass_sequence=4,
            next_step="persist",
        ))
        logger.info(
            "[HandoffCompiler] Handoff assembly complete: status=%s",
            package.readiness.handoff_status,
        )

    async def _persist_artifacts(self):
        """Persist all three artifacts in a single DB transaction."""
        if not self._ctx.opening_package:
            return None, {}

        stats = self._ctx.extraction_stats()
        n_gaps = len(self._ctx.gap_analysis.unresolved_items) if self._ctx.gap_analysis else 0
        n_contradictions = len(self._ctx.gap_analysis.contradictions) if self._ctx.gap_analysis else 0
        blocked = not self._ctx.gap_analysis.handoff_safe if self._ctx.gap_analysis else False

        checkpoints_dicts = [
            json.loads(cp.model_dump_json()) for cp in self._ctx.checkpoints
        ]

        artifacts = {"opening_state_package": self._ctx.opening_package}
        if self._ctx.entity_resolution:
            artifacts["entity_graph"] = self._ctx.entity_resolution
        if self._ctx.gap_analysis:
            artifacts["gap_analysis"] = self._ctx.gap_analysis

        run, saved = save_artifacts_transactional(
            self.session_id,
            artifacts,
            run_type=self.run_type,
            transcript_hash=self._ctx.transcript_hash,
            character_draft_hash=self._ctx.draft_hash,
            run_metadata={
                "entities_extracted": stats["entities"],
                "entities_resolved": len(self._ctx.entity_resolution.canonical_entities) if self._ctx.entity_resolution else 0,
                "contradictions_found": n_contradictions,
                "unresolved_items": n_gaps,
                "handoff_blocked": blocked,
                "checkpoints": checkpoints_dicts,
            },
        )

        # Stamp artifact version into the package metadata
        if "opening_state_package" in saved:
            self._ctx.opening_package.package_metadata.package_version = saved["opening_state_package"].version
            self._ctx.opening_package.package_metadata.source_run_id = run.id

        logger.info(
            "[HandoffCompiler] Artifacts persisted: run.id=%s version=%s",
            run.id,
            saved.get("opening_state_package", {}).version if saved else "?",
        )
        return run, saved

    # ──────────────────────────────────────────────────────────────────────
    # Static helpers
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def load_active_package(session_id: str) -> OpeningStatePackage | None:
        """Load the current active OpeningStatePackage for a session, or None."""
        with get_session() as db:
            artifact = get_active_artifact(db, session_id, "opening_state_package")
            if artifact is None:
                return None
            return load_artifact_content(artifact, OpeningStatePackage)

    @staticmethod
    def load_active_gap_analysis(session_id: str) -> GapAnalysisOutput | None:
        """Load the current active GapAnalysisOutput for a session, or None."""
        with get_session() as db:
            artifact = get_active_artifact(db, session_id, "gap_analysis")
            if artifact is None:
                return None
            return load_artifact_content(artifact, GapAnalysisOutput)
