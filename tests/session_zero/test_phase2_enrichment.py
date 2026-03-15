"""Phase 2 Handoff Compiler Enrichment tests.

Verifies that after assembly, HandoffCompiler stamps the four enrichment
fields into OpeningStatePackage without any live LLM calls:

  - relationship_graph   ← EntityResolutionOutput.canonical_relationships
  - contradictions_summary ← GapAnalysisOutput.contradictions
  - orphan_facts         ← fact_records with no canonical entity match
  - lore_synthesis_notes ← canonicality signals with hybrid/custom/alternate mode
"""

import os
import pytest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")


# ─────────────────────────────────────────────────────────────
# Unit tests for the two pure helper functions
# ─────────────────────────────────────────────────────────────

class TestComputeOrphanFacts:
    """_compute_orphan_facts() returns facts whose subject_entity_id is missing
    from the canonical entity list."""

    def test_empty_inputs_returns_empty(self):
        from src.core.session_zero_compiler import _compute_orphan_facts
        from src.agents.session_zero_schemas import EntityResolutionOutput
        result = _compute_orphan_facts([], EntityResolutionOutput())
        assert result == []

    def test_no_entity_resolution_returns_empty(self):
        from src.core.session_zero_compiler import _compute_orphan_facts
        from src.agents.session_zero_schemas import ExtractionPassOutput, FactRecord
        passes = [ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=2,
            fact_records=[FactRecord(fact_id="f1", fact_type="backstory_beat", content="Lost his eye", subject_entity_id="ent_zoro")],
        )]
        result = _compute_orphan_facts(passes, None)
        assert result == []

    def test_fact_with_canonical_entity_is_not_orphaned(self):
        from src.core.session_zero_compiler import _compute_orphan_facts
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, FactRecord, EntityResolutionOutput, EntityRecord,
        )
        entity = EntityRecord(
            canonical_id="ent_zoro", display_name="Zoro",
            entity_type="character",
        )
        passes = [ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=2,
            fact_records=[FactRecord(fact_id="f1", fact_type="backstory_beat", content="Lost his eye", subject_entity_id="ent_zoro")],
        )]
        resolution = EntityResolutionOutput(canonical_entities=[entity])
        result = _compute_orphan_facts(passes, resolution)
        assert result == []

    def test_fact_with_unknown_entity_is_orphaned(self):
        from src.core.session_zero_compiler import _compute_orphan_facts
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, FactRecord, EntityResolutionOutput, EntityRecord,
        )
        entity = EntityRecord(
            canonical_id="ent_zoro", display_name="Zoro",
            entity_type="character",
        )
        passes = [ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=2,
            fact_records=[
                FactRecord(fact_id="f1", fact_type="backstory_beat", content="Lost his eye", subject_entity_id="ent_zoro"),
                FactRecord(fact_id="f2", fact_type="world_rule", content="Marines patrol the sea", subject_entity_id="ent_unknown_faction"),
                FactRecord(fact_id="f3", fact_type="world_rule", content="Devil fruit users sink", subject_entity_id=None),
            ],
        )]
        resolution = EntityResolutionOutput(canonical_entities=[entity])
        orphans = _compute_orphan_facts(passes, resolution)
        orphan_ids = {f.fact_id for f in orphans}
        assert "f1" not in orphan_ids
        assert "f2" in orphan_ids  # unknown entity
        assert "f3" in orphan_ids  # no subject at all

    def test_duplicate_facts_across_chunks_deduplicated(self):
        from src.core.session_zero_compiler import _compute_orphan_facts
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, FactRecord, EntityResolutionOutput,
        )
        fact = FactRecord(fact_id="f1", fact_type="world_rule", content="Same fact", subject_entity_id=None)
        passes = [
            ExtractionPassOutput(chunk_start_index=0, chunk_end_index=2, fact_records=[fact]),
            ExtractionPassOutput(chunk_start_index=2, chunk_end_index=4, fact_records=[fact]),
        ]
        orphans = _compute_orphan_facts(passes, EntityResolutionOutput())
        assert len(orphans) == 1

class TestExtractLoreSynthesisNotes:
    """_extract_lore_synthesis_notes() collects hybrid/custom/alternate signals."""

    def test_empty_passes_returns_empty(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        assert _extract_lore_synthesis_notes([]) == []

    def test_canon_signals_excluded(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        from src.agents.session_zero_schemas import ExtractionPassOutput, CanonicalitySignal
        signal = CanonicalitySignal(signal_id="s1", signal_type="timeline_mode", content="strict canon only", timeline_mode="canon")
        passes = [ExtractionPassOutput(chunk_start_index=0, chunk_end_index=2, canonicality_signals=[signal])]
        assert _extract_lore_synthesis_notes(passes) == []

    def test_hybrid_signal_included(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        from src.agents.session_zero_schemas import ExtractionPassOutput, CanonicalitySignal
        signal = CanonicalitySignal(
            signal_id="s1", signal_type="timeline_mode",
            content="Naruto exists but Bleach characters also present",
            timeline_mode="hybrid",
        )
        passes = [ExtractionPassOutput(chunk_start_index=0, chunk_end_index=2, canonicality_signals=[signal])]
        notes = _extract_lore_synthesis_notes(passes)
        assert len(notes) == 1
        assert "hybrid" in notes[0]
        assert "Naruto" in notes[0]

    def test_alternate_and_custom_included(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        from src.agents.session_zero_schemas import ExtractionPassOutput, CanonicalitySignal
        signals = [
            CanonicalitySignal(signal_id="s1", signal_type="divergence", content="Alt timeline where Itachi lived", timeline_mode="alternate"),
            CanonicalitySignal(signal_id="s2", signal_type="custom_rule", content="No chakra system exists", timeline_mode="custom"),
        ]
        passes = [ExtractionPassOutput(chunk_start_index=0, chunk_end_index=4, canonicality_signals=signals)]
        notes = _extract_lore_synthesis_notes(passes)
        assert len(notes) == 2

    def test_forbidden_contradiction_included_regardless_of_mode(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        from src.agents.session_zero_schemas import ExtractionPassOutput, CanonicalitySignal
        signal = CanonicalitySignal(
            signal_id="s1", signal_type="forbidden_conflict",
            content="Must never contradict: father is alive",
            timeline_mode=None,  # no mode set
            is_forbidden_contradiction=True,
        )
        passes = [ExtractionPassOutput(chunk_start_index=0, chunk_end_index=2, canonicality_signals=[signal])]
        notes = _extract_lore_synthesis_notes(passes)
        assert len(notes) == 1
        assert "Must never contradict" in notes[0]

    def test_duplicate_notes_across_chunks_deduplicated(self):
        from src.core.session_zero_compiler import _extract_lore_synthesis_notes
        from src.agents.session_zero_schemas import ExtractionPassOutput, CanonicalitySignal
        signal = CanonicalitySignal(signal_id="s1", signal_type="timeline_mode", content="Same hybrid note", timeline_mode="hybrid")
        passes = [
            ExtractionPassOutput(chunk_start_index=0, chunk_end_index=2, canonicality_signals=[signal]),
            ExtractionPassOutput(chunk_start_index=2, chunk_end_index=4, canonicality_signals=[signal]),
        ]
        assert len(_extract_lore_synthesis_notes(passes)) == 1


# ─────────────────────────────────────────────────────────────
# Integration test: compiler stamps enrichment fields
# ─────────────────────────────────────────────────────────────

def _minimal_messages():
    return [
        {"role": "assistant", "content": "What world and character?"},
        {"role": "user", "content": "Zoro from One Piece, alternate timeline where Kuina survived."},
        {"role": "assistant", "content": "Where does the story begin?"},
        {"role": "user", "content": "Docked at East Blue, dawn before departure."},
    ]


@pytest.mark.asyncio
class TestCompilerEnrichmentStamping:
    """Verify enrichment fields are stamped by compiler, not left empty."""

    async def test_relationship_graph_stamped_from_entity_resolution(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
            EntityRecord, RelationshipRecord, OpeningStatePackage, PackageMetadata,
            PackageReadiness, PlayerCharacterBrief, OpeningSituation,
        )
        Base.metadata.create_all(bind=get_engine())

        rel = RelationshipRecord(
            relationship_id="rel_zoro_kuina",
            from_entity_id="ent_zoro", to_entity_id="ent_kuina",
            relationship_type="rivals",
        )
        entities = [
            EntityRecord(canonical_id="ent_zoro", display_name="Zoro", entity_type="character"),
            EntityRecord(canonical_id="ent_kuina", display_name="Kuina", entity_type="character"),
        ]
        resolution = EntityResolutionOutput(canonical_entities=entities, canonical_relationships=[rel])
        gap = GapAnalysisOutput(handoff_safe=True)
        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="enrich-session", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(name="Zoro"),
            opening_situation=OpeningSituation(immediate_situation="Docked at East Blue"),
        )

        mock_provider.queue_schema_response(ExtractionPassOutput(chunk_start_index=0, chunk_end_index=4))
        mock_provider.queue_schema_response(resolution)
        mock_provider.queue_schema_response(gap)
        mock_provider.queue_schema_response(package)

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            result = await HandoffCompiler(
                session_id="enrich-session",
                messages=_minimal_messages(),
                character_draft={"name": "Zoro"},
                campaign_id=1,
            ).run()

        assert result.success
        pkg = result.opening_state_package
        assert len(pkg.relationship_graph) == 1
        assert pkg.relationship_graph[0].relationship_id == "rel_zoro_kuina"

    async def test_contradictions_summary_stamped_from_gap_analysis(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
            ContradictionRecord, OpeningStatePackage, PackageMetadata,
            PackageReadiness, PlayerCharacterBrief, OpeningSituation,
        )
        Base.metadata.create_all(bind=get_engine())

        contradiction = ContradictionRecord(
            issue_id="con_001",
            issue_type="timeline_conflict",
            statements=["Kuina died at age 11", "Kuina survived and became a captain"],
            entities_involved=["ent_kuina"],
            is_blocking=False,
        )
        gap = GapAnalysisOutput(handoff_safe=True, contradictions=[contradiction])
        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="contra-session", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(name="Zoro"),
            opening_situation=OpeningSituation(immediate_situation="Docked"),
        )

        mock_provider.queue_schema_response(ExtractionPassOutput(chunk_start_index=0, chunk_end_index=4))
        mock_provider.queue_schema_response(EntityResolutionOutput())
        mock_provider.queue_schema_response(gap)
        mock_provider.queue_schema_response(package)

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            result = await HandoffCompiler(
                session_id="contra-session",
                messages=_minimal_messages(),
                character_draft={"name": "Zoro"},
                campaign_id=1,
            ).run()

        assert result.success
        pkg = result.opening_state_package
        assert len(pkg.contradictions_summary) == 1
        assert pkg.contradictions_summary[0].issue_id == "con_001"

    async def test_orphan_facts_stamped_when_entity_unresolved(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
            FactRecord, EntityRecord, OpeningStatePackage, PackageMetadata,
            PackageReadiness, PlayerCharacterBrief, OpeningSituation,
        )
        Base.metadata.create_all(bind=get_engine())

        entity = EntityRecord(canonical_id="ent_zoro", display_name="Zoro", entity_type="character")
        orphan_fact = FactRecord(
            fact_id="f_orphan", fact_type="world_rule",
            content="The unnamed guild rules the underworld",
            subject_entity_id="ent_unknown_guild",  # not in canonical entities
        )
        extraction = ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=4,
            fact_records=[orphan_fact],
        )
        resolution = EntityResolutionOutput(canonical_entities=[entity])
        gap = GapAnalysisOutput(handoff_safe=True)
        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="orphan-session", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(name="Zoro"),
            opening_situation=OpeningSituation(immediate_situation="Docked"),
        )

        mock_provider.queue_schema_response(extraction)
        mock_provider.queue_schema_response(resolution)
        mock_provider.queue_schema_response(gap)
        mock_provider.queue_schema_response(package)

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            result = await HandoffCompiler(
                session_id="orphan-session",
                messages=_minimal_messages(),
                character_draft={"name": "Zoro"},
                campaign_id=1,
            ).run()

        assert result.success
        pkg = result.opening_state_package
        assert any(f.fact_id == "f_orphan" for f in pkg.orphan_facts)

    async def test_lore_synthesis_notes_stamped_for_hybrid_profile(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
            CanonicalitySignal, OpeningStatePackage, PackageMetadata,
            PackageReadiness, PlayerCharacterBrief, OpeningSituation,
        )
        Base.metadata.create_all(bind=get_engine())

        hybrid_signal = CanonicalitySignal(
            signal_id="sig_001", signal_type="timeline_mode",
            content="One Piece meets Naruto — chakra and devil fruits coexist",
            timeline_mode="hybrid",
        )
        extraction = ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=4,
            canonicality_signals=[hybrid_signal],
        )
        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="lore-session", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(name="Zoro"),
            opening_situation=OpeningSituation(immediate_situation="Docked"),
        )

        mock_provider.queue_schema_response(extraction)
        mock_provider.queue_schema_response(EntityResolutionOutput())
        mock_provider.queue_schema_response(GapAnalysisOutput(handoff_safe=True))
        mock_provider.queue_schema_response(package)

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            result = await HandoffCompiler(
                session_id="lore-session",
                messages=_minimal_messages(),
                character_draft={"name": "Zoro"},
                campaign_id=1,
            ).run()

        assert result.success
        pkg = result.opening_state_package
        assert len(pkg.lore_synthesis_notes) == 1
        assert "hybrid" in pkg.lore_synthesis_notes[0]
        assert "One Piece" in pkg.lore_synthesis_notes[0]

    async def test_enrichment_empty_on_minimal_run(self, mock_provider, fresh_db):
        """Compiler with minimal extraction (no relationships/contradictions/orphans/hybrid)
        produces empty enrichment fields — not None, not an error."""
        from src.db.models import Base
        from src.db.session import get_engine
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
            OpeningStatePackage, PackageMetadata, PackageReadiness,
            PlayerCharacterBrief, OpeningSituation,
        )
        Base.metadata.create_all(bind=get_engine())

        mock_provider.queue_schema_response(ExtractionPassOutput(chunk_start_index=0, chunk_end_index=4))
        mock_provider.queue_schema_response(EntityResolutionOutput())
        mock_provider.queue_schema_response(GapAnalysisOutput(handoff_safe=True))
        mock_provider.queue_schema_response(OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="minimal-enrich", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(name="Zoro"),
            opening_situation=OpeningSituation(immediate_situation="Docked"),
        ))

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            result = await HandoffCompiler(
                session_id="minimal-enrich",
                messages=_minimal_messages(),
                character_draft={"name": "Zoro"},
                campaign_id=1,
            ).run()

        assert result.success
        pkg = result.opening_state_package
        assert pkg.relationship_graph == []
        assert pkg.contradictions_summary == []
        assert pkg.orphan_facts == []
        assert pkg.lore_synthesis_notes == []
