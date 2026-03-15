"""Phase 4 tests — SZ pipeline hardening: error recovery, Langfuse spans,
extraction summary, resumability.

All tests are fully offline using MockLLMProvider. Zero live LLM calls.
"""

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agents.session_zero import SessionZeroAgent, SessionZeroOutput
from src.agents.session_zero_schemas import (
    EntityRecord,
    EntityResolutionOutput,
    EntityType,
    ExtractionPassOutput,
    FactRecord,
    GapAnalysisOutput,
    RelationshipRecord,
    UnresolvedCategory,
    UnresolvedItem,
)
from src.core.session_zero_pipeline import SessionZeroPipeline, SZPipelineState
from tests.mock_llm import MockLLMProvider


# ── Shared fixtures ───────────────────────────────────────────────────────────

@pytest.fixture
def mock_session():
    session = MagicMock()
    session.session_id = "test-session-err"
    session.phase = MagicMock()
    session.phase.value = "media_detection"
    session.messages = [
        {"role": "assistant", "content": "Welcome!"},
        {"role": "user", "content": "I want to play Naruto"},
    ]
    session.character_draft = MagicMock()
    session.character_draft.to_dict.return_value = {"name": "Kai", "concept": "ninja"}
    session.character_draft.narrative_profile = None
    session.character_draft.name = "Kai"
    session.character_draft.concept = "ninja"
    session.character_draft.backstory = None
    session.character_draft.personality_traits = []
    session.character_draft.skills = []
    session.character_draft.appearance = None
    session.character_draft.starting_location = None
    session.character_draft.power_tier = None
    session.character_draft.op_protagonist_enabled = False
    session.character_draft.op_preset = None
    session.character_draft.values = []
    session.character_draft.fears = []
    session.character_draft.media_reference = None
    session.phase_state = {}
    return session


def _make_extraction(**overrides):
    defaults = dict(
        chunk_start_index=0,
        chunk_end_index=2,
        entity_records=[],
        relationship_records=[],
        fact_records=[],
    )
    defaults.update(overrides)
    return ExtractionPassOutput(**defaults)


def _make_resolution(**overrides):
    defaults = dict(
        canonical_entities=[],
        merges_performed=[],
        alias_map={},
    )
    defaults.update(overrides)
    return EntityResolutionOutput(**defaults)


def _make_gap(**overrides):
    defaults = dict(
        unresolved_items=[],
        contradictions=[],
        handoff_safe=True,
        blocking_issues=[],
        warnings=[],
        recommended_player_followups=[],
    )
    defaults.update(overrides)
    return GapAnalysisOutput(**defaults)


def _make_conductor_output(**overrides):
    defaults = dict(
        response="Tell me more!",
        ready_for_gameplay=False,
    )
    defaults.update(overrides)
    return SessionZeroOutput(**defaults)


# ── Tests: Error recovery (4.1) ──────────────────────────────────────────────

class TestErrorRecovery:
    """Each pipeline step failure is handled gracefully."""

    async def test_extractor_failure_continues(self, mock_session):
        """When extraction fails, conductor still responds normally."""
        provider = MockLLMProvider()
        conductor_output = _make_conductor_output()
        provider.queue_schema_response(conductor_output)

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="err-test")

        # Make extractor raise
        pipeline._extractor.extract_chunk = AsyncMock(
            side_effect=RuntimeError("LLM timeout")
        )

        with patch.object(conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_pipeline_state', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            result = await pipeline.process_turn(mock_session, "hello")

        assert result.response == "Tell me more!"
        assert len(pipeline.state.extraction_passes) == 0
        assert pipeline.state.turn_count == 1

    async def test_resolver_failure_uses_prior_graph(self, mock_session):
        """When entity resolver fails, prior entity graph is preserved."""
        provider = MockLLMProvider()

        extraction = _make_extraction(entity_records=[
            EntityRecord(canonical_id="npc_1", entity_type=EntityType.NPC, display_name="NPC1"),
        ])
        provider.queue_schema_response(extraction)
        conductor_output = _make_conductor_output()
        provider.queue_schema_response(conductor_output)

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="err-test")

        # Set a prior entity graph
        prior_graph = _make_resolution(canonical_entities=[
            EntityRecord(canonical_id="npc_old", entity_type=EntityType.NPC, display_name="OldNPC"),
        ])
        pipeline._state.entity_resolution = prior_graph

        # Make resolver raise
        pipeline._resolver.resolve = AsyncMock(
            side_effect=RuntimeError("Resolution failed")
        )

        with patch.object(pipeline._extractor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_pipeline_state', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            result = await pipeline.process_turn(mock_session, "hello")

        # Prior graph should be preserved
        assert pipeline.state.entity_resolution is prior_graph
        assert pipeline.state.entity_resolution.canonical_entities[0].canonical_id == "npc_old"
        assert result.response == "Tell me more!"

    async def test_gap_analyzer_failure_no_gap_context(self, mock_session):
        """When gap analyzer fails, conductor runs without gap context."""
        provider = MockLLMProvider()

        extraction = _make_extraction()
        provider.queue_schema_response(extraction)
        resolution = _make_resolution()
        provider.queue_schema_response(resolution)
        conductor_output = _make_conductor_output()
        provider.queue_schema_response(conductor_output)

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="err-test")

        # Give it a prior entity resolution so gap analysis runs
        pipeline._state.entity_resolution = _make_resolution()
        pipeline._state.extraction_passes.append(_make_extraction())

        # Make gap analyzer raise
        pipeline._gap_analyzer.analyze = AsyncMock(
            side_effect=RuntimeError("Gap analysis crashed")
        )

        with patch.object(pipeline._extractor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(pipeline._resolver, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_pipeline_state', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            result = await pipeline.process_turn(mock_session, "hello")

        assert result.response == "Tell me more!"
        assert pipeline.state.gap_analysis is None  # No gap analysis due to failure

    async def test_conductor_failure_propagates(self, mock_session):
        """Conductor failure should propagate (not silently swallowed)."""
        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="err-test")

        # Make conductor raise
        conductor.process_turn = AsyncMock(
            side_effect=RuntimeError("LLM provider down")
        )

        with pytest.raises(RuntimeError, match="LLM provider down"):
            await pipeline.process_turn(mock_session, "hello")

    def test_provisional_memory_failure_nonfatal(self):
        """Memory write failure doesn't crash the pipeline."""
        from src.core.session_zero_memory import write_provisional

        store = MagicMock()
        store.add_memory.side_effect = RuntimeError("DB connection lost")

        extraction = _make_extraction(fact_records=[
            FactRecord(
                fact_id="f1", fact_type="backstory_beat",
                content="test fact", confidence=0.95,
            ),
        ])
        written = write_provisional(store, extraction, turn_number=1)
        assert written == 0  # Failed but no exception

    def test_authoritative_memory_failure_nonfatal(self):
        """Authoritative memory write failure doesn't crash handoff."""
        from src.core.session_zero_memory import write_authoritative
        from src.agents.session_zero_schemas import (
            OpeningStatePackage,
            PackageMetadata,
            PlayerCharacterBrief,
        )

        store = MagicMock()
        store.add_memory.side_effect = RuntimeError("DB connection lost")

        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="test"),
            player_character=PlayerCharacterBrief(
                name="Kai", concept="ninja", core_identity="test", power_tier="T8",
            ),
        )
        written = write_authoritative(store, package)
        assert written == 0  # Failed but no exception


# ── Tests: Langfuse spans (4.3) ──────────────────────────────────────────────

class TestLangfuseSpans:
    """Verify log_span() is called with correct data at each pipeline step."""

    async def test_pipeline_logs_extraction_span(self, mock_session):
        """Extraction step logs a span with entity/fact counts."""
        provider = MockLLMProvider()

        extraction = _make_extraction(
            entity_records=[
                EntityRecord(canonical_id="npc_1", entity_type=EntityType.NPC, display_name="NPC1"),
            ],
            fact_records=[
                FactRecord(fact_id="f1", fact_type="world_rule", content="test", confidence=0.5),
            ],
        )
        provider.queue_schema_response(extraction)
        provider.queue_schema_response(_make_conductor_output())

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="span-test")

        with patch.object(pipeline._extractor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_pipeline_state', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""), \
             patch('src.core.session_zero_pipeline.log_span') as mock_log_span:

            await pipeline.process_turn(mock_session, "hello")

        # Find the extraction span call
        extraction_calls = [
            c for c in mock_log_span.call_args_list
            if c.args[0] == "sz_pipeline.extraction"
        ]
        assert len(extraction_calls) == 1
        output = extraction_calls[0].kwargs.get("output") or extraction_calls[0][1].get("output", {})
        assert output["entity_count"] == 1
        assert output["fact_count"] == 1

    async def test_pipeline_logs_conductor_span(self, mock_session):
        """Conductor step logs a span with phase and readiness."""
        provider = MockLLMProvider()

        provider.queue_schema_response(_make_conductor_output(response="Go!", ready_for_gameplay=False))

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="span-test")

        with patch.object(conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_pipeline_state', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""), \
             patch('src.core.session_zero_pipeline.log_span') as mock_log_span:

            await pipeline.process_turn(mock_session, "test")

        conductor_calls = [
            c for c in mock_log_span.call_args_list
            if c.args[0] == "sz_pipeline.conductor"
        ]
        assert len(conductor_calls) == 1


# ── Tests: Extraction summary (4.4) ──────────────────────────────────────────

class TestExtractionSummary:
    """Verify build_extraction_summary() produces correct data."""

    def test_no_summary_when_no_passes(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        assert pipeline.build_extraction_summary() is None

    def test_summary_with_extraction_data(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)

        pipeline._state.extraction_passes.append(
            _make_extraction(
                fact_records=[
                    FactRecord(fact_id="f1", fact_type="world_rule", content="test"),
                ],
            )
        )
        pipeline._state.entity_resolution = _make_resolution(
            canonical_entities=[
                EntityRecord(canonical_id="npc_1", entity_type=EntityType.NPC, display_name="NPC1"),
            ],
            canonical_relationships=[
                RelationshipRecord(
                    relationship_id="r1", from_entity_id="pc_kai",
                    to_entity_id="npc_1", relationship_type="ally",
                ),
            ],
        )
        pipeline._state.gap_analysis = _make_gap(
            unresolved_items=[
                UnresolvedItem(
                    item_id="g1", category=UnresolvedCategory.LOCATION,
                    description="Missing location", why_it_matters="Needed",
                ),
            ],
            handoff_safe=False,
        )
        pipeline._state.turn_count = 3

        summary = pipeline.build_extraction_summary()
        assert summary is not None
        assert summary["entity_count"] == 1
        assert summary["fact_count"] == 1
        assert summary["relationship_count"] == 1
        assert summary["unresolved_count"] == 1
        assert summary["handoff_safe"] is False
        assert summary["turn_count"] == 3

    def test_summary_without_gap_analysis(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        pipeline._state.extraction_passes.append(_make_extraction())
        pipeline._state.turn_count = 1

        summary = pipeline.build_extraction_summary()
        assert summary["entity_count"] == 0
        assert summary["unresolved_count"] == 0
        assert summary["handoff_safe"] is None


# ── Tests: Research flag (4.5) ────────────────────────────────────────────────

class TestResearchFlag:
    """Verify SESSION_ZERO_RESEARCH_ENABLED config flag."""

    def test_research_flag_exists_and_defaults_false(self):
        from src.config import Config
        assert hasattr(Config, "SESSION_ZERO_RESEARCH_ENABLED")
        # Default is False (unless env var is set)
        assert Config.SESSION_ZERO_RESEARCH_ENABLED is False or \
               os.environ.get("SESSION_ZERO_RESEARCH_ENABLED", "false").lower() == "true"


# ── Tests: Response enrichment (4.4 response model) ──────────────────────────

class TestResponseModel:
    """Verify SessionZeroResponse has extraction_summary field."""

    def test_extraction_summary_field_exists(self):
        from api.routes.game.models import SessionZeroResponse

        resp = SessionZeroResponse(
            response="test",
            phase="media_detection",
            phase_complete=False,
            character_draft={},
            session_id="test-001",
            extraction_summary={"entity_count": 5, "handoff_safe": True},
        )
        assert resp.extraction_summary["entity_count"] == 5
        assert resp.extraction_summary["handoff_safe"] is True

    def test_extraction_summary_defaults_none(self):
        from api.routes.game.models import SessionZeroResponse

        resp = SessionZeroResponse(
            response="test",
            phase="media_detection",
            phase_complete=False,
            character_draft={},
            session_id="test-001",
        )
        assert resp.extraction_summary is None


# ── Tests: Resumability (4.2) ────────────────────────────────────────────────

class TestResumability:
    """Verify pipeline state restoration from artifacts."""

    def test_load_prior_state_restores_entity_graph(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)

        mock_artifact = MagicMock()
        mock_artifact.version = 3
        mock_artifact.content = '{"canonical_entities": [], "canonical_relationships": [], "merges_performed": [], "alias_map": {}, "schema_version": 1}'

        mock_meta_artifact = MagicMock()
        mock_meta_artifact.content = '{"turn_count": 7, "extraction_pass_count": 5}'

        def side_effect_get_artifact(db, session_id, artifact_type):
            if artifact_type == "sz_entity_graph":
                return mock_artifact
            elif artifact_type == "sz_pipeline_meta":
                return mock_meta_artifact
            return None

        with patch('src.db.session.get_session') as mock_get_session, \
             patch('src.db.session_zero_artifacts.get_active_artifact', side_effect=side_effect_get_artifact), \
             patch('src.db.session_zero_artifacts.load_artifact_content') as mock_load:

            mock_db = MagicMock()
            mock_get_session.return_value = mock_db
            mock_load.return_value = _make_resolution()

            result = pipeline.load_prior_state("test-session")

        assert result is True
        assert pipeline.state.entity_resolution is not None
        assert pipeline.state.turn_count == 7
        assert pipeline.session_id == "test-session"

    def test_load_prior_state_returns_false_when_empty(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)

        with patch('src.db.session.get_session') as mock_get_session, \
             patch('src.db.session_zero_artifacts.get_active_artifact', return_value=None):
            mock_db = MagicMock()
            mock_get_session.return_value = mock_db
            result = pipeline.load_prior_state("test-session")

        assert result is False
        assert pipeline.state.entity_resolution is None
        assert pipeline.state.turn_count == 0

    def test_backward_compat_alias(self):
        """load_prior_entity_graph is an alias for load_prior_state."""
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        assert pipeline.load_prior_entity_graph == pipeline.load_prior_state
