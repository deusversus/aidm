"""Phase 3 tests — SZ per-turn pipeline, memory integration, entity graph persistence.

All tests are fully offline using MockLLMProvider. Zero live LLM calls.
"""

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agents.session_zero import SessionZeroAgent, SessionZeroOutput
from src.agents.session_zero_schemas import (
    CastMember,
    ContradictionRecord,
    ContradictionType,
    EntityRecord,
    EntityResolutionOutput,
    EntityType,
    ExtractionPassOutput,
    FactRecord,
    GapAnalysisOutput,
    MergeHistoryEntry,
    OpeningCast,
    OpeningStatePackage,
    OpeningSituation,
    PackageMetadata,
    PackageReadiness,
    PlayerCharacterBrief,
    RelationshipRecord,
    UnresolvedCategory,
    UnresolvedItem,
    WorldContextBrief,
    ActiveThreadsBrief,
)
from src.core.session_zero_memory import write_authoritative, write_provisional
from src.core.session_zero_pipeline import SessionZeroPipeline, SZPipelineState
from tests.mock_llm import MockLLMProvider


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_session():
    """Minimal session stub for pipeline tests."""
    session = MagicMock()
    session.session_id = "test-session-001"
    session.phase = MagicMock()
    session.phase.value = "media_detection"
    session.messages = [
        {"role": "assistant", "content": "Welcome! What anime are you thinking of?"},
        {"role": "user", "content": "I want to play in the Cowboy Bebop universe"},
        {"role": "assistant", "content": "Great choice! Tell me about your character."},
        {"role": "user", "content": "A bounty hunter named Kai who owes Julia a debt"},
    ]
    session.character_draft = MagicMock()
    session.character_draft.to_dict.return_value = {
        "name": "Kai",
        "concept": "Bounty hunter",
        "media_reference": "Cowboy Bebop",
    }
    session.character_draft.narrative_profile = "cowboy_bebop"
    session.character_draft.name = "Kai"
    session.character_draft.concept = "Bounty hunter"
    session.character_draft.media_reference = "Cowboy Bebop"
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
    session.phase_state = {}
    return session


@pytest.fixture
def mock_extraction():
    """Sample ExtractionPassOutput."""
    return ExtractionPassOutput(
        chunk_start_index=0,
        chunk_end_index=4,
        entity_records=[
            EntityRecord(
                canonical_id="npc_julia",
                entity_type=EntityType.NPC,
                display_name="Julia",
                aliases=["Jules"],
                description="A mysterious woman with connections to the syndicate",
            ),
        ],
        relationship_records=[
            RelationshipRecord(
                relationship_id="rel_pc_julia_debt",
                from_entity_id="pc_kai",
                to_entity_id="npc_julia",
                relationship_type="owes_debt_to",
                description="Kai owes Julia for saving his life",
                confidence=0.9,
            ),
        ],
        fact_records=[
            FactRecord(
                fact_id="fact_001_julia_debt",
                subject_entity_id="npc_julia",
                fact_type="backstory_beat",
                content="Kai owes Julia a life debt from a botched bounty job",
                confidence=0.95,
            ),
            FactRecord(
                fact_id="fact_002_bounty_hunters_guild",
                subject_entity_id=None,
                fact_type="world_rule",
                content="The Bounty Hunters Guild operates across the solar system",
                confidence=0.7,
            ),
        ],
        opening_scene_cues=[],
        canonicality_signals=[],
    )


@pytest.fixture
def mock_entity_resolution():
    """Sample EntityResolutionOutput."""
    return EntityResolutionOutput(
        canonical_entities=[
            EntityRecord(
                canonical_id="npc_julia",
                entity_type=EntityType.NPC,
                display_name="Julia",
                aliases=["Jules"],
                description="A mysterious woman with connections to the syndicate",
            ),
        ],
        merges_performed=[],
        alias_map={"Jules": "npc_julia"},
    )


@pytest.fixture
def mock_gap_analysis():
    """Sample GapAnalysisOutput."""
    return GapAnalysisOutput(
        unresolved_items=[
            UnresolvedItem(
                item_id="gap_01",
                category=UnresolvedCategory.LOCATION,
                description="Starting location not specified",
                why_it_matters="Cannot generate opening scene without a location",
                priority="high",
                candidate_followup="Where does Kai usually hang out?",
            ),
        ],
        contradictions=[],
        handoff_safe=False,
        blocking_issues=["Starting location not yet defined"],
        warnings=["No backstory details beyond the debt"],
        recommended_player_followups=[
            "Where does Kai usually hang out?",
            "Tell me more about Kai's personality",
        ],
    )


@pytest.fixture
def mock_memory_store():
    """Mock MemoryStore for testing memory writes."""
    store = MagicMock()
    store.add_memory = MagicMock(return_value="1")
    return store


@pytest.fixture
def sample_opening_package():
    """Minimal OpeningStatePackage for handoff memory tests."""
    return OpeningStatePackage(
        package_metadata=PackageMetadata(
            session_id="test-session-001",
            campaign_id=1,
        ),
        readiness=PackageReadiness(),
        player_character=PlayerCharacterBrief(
            name="Kai",
            concept="Bounty hunter with a dark past",
            core_identity="A debt-ridden bounty hunter seeking redemption",
            power_tier="T8",
            backstory_beats=[
                "Raised on Mars in the slums",
                "Owes Julia a life debt",
            ],
        ),
        opening_situation=OpeningSituation(
            starting_location="The Bebop, docked at Ganymede",
            immediate_situation="A new bounty has just been posted",
        ),
        opening_cast=OpeningCast(
            required_present=[
                CastMember(
                    canonical_id="npc_julia",
                    display_name="Julia",
                    role_in_scene="mysterious contact",
                    relationship_to_pc="creditor — Kai owes her his life",
                ),
            ],
        ),
        world_context=WorldContextBrief(
            location_description="A battered fishing ship repurposed as a bounty vessel",
            setting_truths=[
                "Hyperspace gates connect the solar system",
                "The ISSP is the interplanetary police",
            ],
            important_recent_facts=[
                "A Red Dragon syndicate crackdown is underway",
            ],
        ),
        active_threads=ActiveThreadsBrief(
            quests_or_hooks_to_surface=[
                "Track down the bounty on 'Hex' Martinez",
            ],
        ),
        relationship_graph=[
            RelationshipRecord(
                relationship_id="rel_pc_julia_debt",
                from_entity_id="pc_kai",
                to_entity_id="npc_julia",
                relationship_type="owes_debt_to",
                description="Kai owes Julia for saving his life",
            ),
        ],
    )


# ── Tests: Pipeline structure ─────────────────────────────────────────────────

class TestSessionZeroPipeline:
    """Tests for the per-turn orchestration pipeline."""

    def test_pipeline_initializes_with_empty_state(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="test-001")
        assert pipeline.state.turn_count == 0
        assert pipeline.state.extraction_passes == []
        assert pipeline.state.entity_resolution is None
        assert pipeline.state.gap_analysis is None

    def test_pipeline_state_restore(self, mock_entity_resolution):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        state = SZPipelineState(
            extraction_passes=[],
            entity_resolution=mock_entity_resolution,
            turn_count=5,
        )
        pipeline.restore_state(state)
        assert pipeline.state.turn_count == 5
        assert pipeline.state.entity_resolution is not None

    async def test_pipeline_full_turn(
        self, mock_session, mock_extraction, mock_entity_resolution, mock_gap_analysis
    ):
        """Test that a full pipeline turn runs extractor → resolver → gap → conductor."""
        provider = MockLLMProvider()

        # Queue responses for each pipeline step
        provider.queue_schema_response(mock_extraction)       # extractor
        provider.queue_schema_response(mock_entity_resolution)  # resolver
        provider.queue_schema_response(mock_gap_analysis)      # gap analyzer
        conductor_output = SessionZeroOutput(
            response="Great! Where does Kai usually hang out?",
            missing_requirements=["starting_location"],
            ready_for_gameplay=False,
        )
        provider.queue_schema_response(conductor_output)       # conductor

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="test-001")

        # Patch all agent providers to use our mock
        with patch.object(pipeline._extractor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(pipeline._resolver, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(pipeline._gap_analyzer, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch.object(pipeline.conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_entity_graph', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value="Profile: Cowboy Bebop"):

            result = await pipeline.process_turn(mock_session, "A bounty hunter named Kai")

        assert result.response == "Great! Where does Kai usually hang out?"
        assert pipeline.state.turn_count == 1
        assert len(pipeline.state.extraction_passes) == 1
        assert pipeline.state.entity_resolution is not None
        assert pipeline.state.gap_analysis is not None
        assert pipeline.state.gap_analysis.handoff_safe is False
        provider.assert_queue_empty()

    async def test_pipeline_extraction_failure_continues(self, mock_session):
        """If extraction fails, the pipeline still runs the conductor."""
        provider = MockLLMProvider()

        # Extraction will fail (exception in extractor)
        conductor_output = SessionZeroOutput(
            response="Tell me more about your character.",
            missing_requirements=["name"],
            ready_for_gameplay=False,
        )
        provider.queue_schema_response(conductor_output)  # conductor only

        conductor = SessionZeroAgent()
        pipeline = SessionZeroPipeline(conductor=conductor, session_id="test-001")

        # Make extractor raise an error
        pipeline._extractor.call = AsyncMock(side_effect=RuntimeError("LLM failed"))

        with patch.object(pipeline.conductor, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.core.session_zero_pipeline.SessionZeroPipeline._persist_entity_graph', new_callable=AsyncMock), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            result = await pipeline.process_turn(mock_session, "hello")

        assert result.response == "Tell me more about your character."
        assert pipeline.state.turn_count == 1
        assert len(pipeline.state.extraction_passes) == 0  # extraction failed
        provider.assert_queue_empty()

    def test_gap_context_formatting(self, mock_gap_analysis, mock_entity_resolution):
        """Test that gap context is formatted for conductor injection."""
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        pipeline._state.gap_analysis = mock_gap_analysis
        pipeline._state.entity_resolution = mock_entity_resolution

        context = pipeline._build_gap_context()
        assert context is not None
        assert "Recommended Follow-Up Questions" in context
        assert "Where does Kai usually hang out?" in context
        assert "Blocking Issues" in context
        assert "Entity Graph Summary" in context
        assert "canonical entities" in context

    def test_gap_context_none_when_no_analysis(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)
        assert pipeline._build_gap_context() is None


# ── Tests: Conductor gap_context injection ────────────────────────────────────

class TestConductorGapContext:
    """Test that SessionZeroAgent accepts gap_context in process_turn."""

    async def test_process_turn_with_gap_context(self, mock_session):
        """Verify gap_context is injected into the LLM prompt."""
        provider = MockLLMProvider()
        output = SessionZeroOutput(
            response="Based on the gaps, where does Kai live?",
            ready_for_gameplay=False,
        )
        provider.queue_schema_response(output)

        agent = SessionZeroAgent()

        with patch.object(agent, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            result = await agent.process_turn(
                mock_session,
                "A bounty hunter",
                gap_context="## Recommended Follow-Up: Where does the character live?",
            )

        assert result.response == "Based on the gaps, where does Kai live?"
        # Verify the gap context was included in the prompt
        call = provider.last_schema_call()
        assert call is not None
        messages = call["messages"]
        # The user message should contain the gap context
        user_msg = next(m for m in messages if m.get("role") == "user")
        assert "Pipeline Analysis" in user_msg["content"]
        assert "Where does the character live?" in user_msg["content"]
        provider.assert_queue_empty()

    async def test_process_turn_without_gap_context(self, mock_session):
        """Without gap_context, no Pipeline Analysis section."""
        provider = MockLLMProvider()
        output = SessionZeroOutput(response="Hello!", ready_for_gameplay=False)
        provider.queue_schema_response(output)

        agent = SessionZeroAgent()

        with patch.object(agent, '_get_provider_and_model', return_value=(provider, "mock")), \
             patch('src.agents._session_zero_research.get_profile_context_for_agent', return_value=""):

            await agent.process_turn(mock_session, "Hi")

        call = provider.last_schema_call()
        user_msg = next(m for m in call["messages"] if m.get("role") == "user")
        assert "Pipeline Analysis" not in user_msg["content"]
        provider.assert_queue_empty()


# ── Tests: Provisional memory writes ──────────────────────────────────────────

class TestProvisionalMemory:
    """Test write_provisional() — mid-SZ memory indexing."""

    def test_writes_high_confidence_facts(self, mock_extraction, mock_memory_store):
        written = write_provisional(mock_memory_store, mock_extraction, turn_number=3)
        # Should write: fact_001 (confidence=0.95, backstory_beat) and fact_002 (world_rule)
        # Plus rel_pc_julia_debt (confidence=0.9, involves PC)
        assert written == 3
        assert mock_memory_store.add_memory.call_count == 3

    def test_fact_types_written(self, mock_extraction, mock_memory_store):
        write_provisional(mock_memory_store, mock_extraction, turn_number=1)
        calls = mock_memory_store.add_memory.call_args_list

        # First call: fact_001 (backstory_beat, confidence 0.95)
        fact_call = calls[0]
        assert fact_call.kwargs["memory_type"] == "session_zero"
        assert "session_zero_in_progress" in fact_call.kwargs["flags"]
        assert "plot_critical" in fact_call.kwargs["flags"]

    def test_relationship_write_requires_pc(self, mock_memory_store):
        """Only relationships involving the PC get written."""
        extraction = ExtractionPassOutput(
            chunk_start_index=0,
            chunk_end_index=1,
            entity_records=[],
            relationship_records=[
                RelationshipRecord(
                    relationship_id="rel_npc_npc",
                    from_entity_id="npc_julia",
                    to_entity_id="npc_vicious",
                    relationship_type="rival",
                    description="Rivals",
                    confidence=0.9,
                ),
            ],
            fact_records=[],
        )
        written = write_provisional(mock_memory_store, extraction, turn_number=1)
        assert written == 0  # NPC-to-NPC relationship not written

    def test_low_confidence_facts_skipped(self, mock_memory_store):
        """Facts below confidence threshold are skipped."""
        extraction = ExtractionPassOutput(
            chunk_start_index=0,
            chunk_end_index=1,
            entity_records=[],
            relationship_records=[],
            fact_records=[
                FactRecord(
                    fact_id="fact_low",
                    fact_type="social_norm",
                    content="Maybe there's a guild?",
                    confidence=0.3,
                ),
            ],
        )
        written = write_provisional(mock_memory_store, extraction, turn_number=1)
        assert written == 0

    def test_memory_write_failure_nonfatal(self, mock_extraction, mock_memory_store):
        """Memory write failures don't crash the pipeline."""
        mock_memory_store.add_memory.side_effect = RuntimeError("DB error")
        written = write_provisional(mock_memory_store, mock_extraction, turn_number=1)
        assert written == 0  # All failed, but no exception raised


# ── Tests: Authoritative memory writes ────────────────────────────────────────

class TestAuthoritativeMemory:
    """Test write_authoritative() — handoff memory indexing."""

    def test_writes_canonical_facts(self, sample_opening_package, mock_memory_store):
        written = write_authoritative(mock_memory_store, sample_opening_package)
        assert written > 0
        assert mock_memory_store.add_memory.call_count == written

    def test_core_character_memory(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        # First call should be the player character core identity
        core_call = calls[0]
        assert core_call.kwargs["memory_type"] == "core"
        assert "Kai" in core_call.kwargs["content"]
        assert "session_zero_canonical" in core_call.kwargs["flags"]

    def test_backstory_beats_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        backstory_calls = [
            c for c in calls
            if "[Backstory]" in c.kwargs.get("content", "")
        ]
        assert len(backstory_calls) == 2  # "Raised on Mars" + "Owes Julia a life debt"

    def test_npc_cast_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        npc_calls = [
            c for c in calls
            if c.kwargs.get("memory_type") == "character_state"
        ]
        assert len(npc_calls) == 1  # Julia
        assert "Julia" in npc_calls[0].kwargs["content"]

    def test_relationship_graph_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        rel_calls = [
            c for c in calls
            if c.kwargs.get("memory_type") == "relationship"
        ]
        assert len(rel_calls) == 1
        assert "owes_debt_to" in rel_calls[0].kwargs["content"]

    def test_setting_truths_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        sz_calls = [
            c for c in calls
            if c.kwargs.get("memory_type") == "session_zero"
        ]
        # 2 setting_truths + 1 important_recent_facts = 3
        assert len(sz_calls) == 3

    def test_quest_hooks_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        quest_calls = [
            c for c in calls
            if c.kwargs.get("memory_type") == "quest"
        ]
        assert len(quest_calls) == 1
        assert "Hex" in quest_calls[0].kwargs["content"]

    def test_location_written(self, sample_opening_package, mock_memory_store):
        write_authoritative(mock_memory_store, sample_opening_package)
        calls = mock_memory_store.add_memory.call_args_list

        loc_calls = [
            c for c in calls
            if c.kwargs.get("memory_type") == "location"
        ]
        assert len(loc_calls) == 1
        assert "Ganymede" in loc_calls[0].kwargs["content"]

    def test_empty_package_writes_nothing(self, mock_memory_store):
        package = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="empty"),
        )
        written = write_authoritative(mock_memory_store, package)
        assert written == 0

    def test_memory_failure_nonfatal(self, sample_opening_package, mock_memory_store):
        mock_memory_store.add_memory.side_effect = RuntimeError("DB error")
        written = write_authoritative(mock_memory_store, sample_opening_package)
        assert written == 0  # All failed, but no exception raised


# ── Tests: Entity graph persistence ───────────────────────────────────────────

class TestEntityGraphPersistence:
    """Test entity graph save/restore via artifacts."""

    def test_load_returns_false_when_no_artifact(self):
        conductor = MagicMock(spec=SessionZeroAgent)
        pipeline = SessionZeroPipeline(conductor=conductor)

        with patch('src.db.session.get_session') as mock_get_session, \
             patch('src.db.session_zero_artifacts.get_active_artifact', return_value=None):
            mock_db = MagicMock()
            mock_get_session.return_value = mock_db
            result = pipeline.load_prior_entity_graph("test-session")

        assert result is False
        assert pipeline.state.entity_resolution is None
