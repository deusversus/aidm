"""Tests for the Session Zero Handoff Compiler pipeline.

Covers:
- Schema roundtrip (OpeningStatePackage, GapAnalysisOutput, etc.)
- Artifact repository (CRUD, content-hash dedup, versioning)
- HandoffCompiler 4-pass pipeline using MockLLMProvider
- ProgressTracker integration during compiler passes
- _build_startup_context() legacy vs package path in DirectorAgent
- generate_opening_scene() dedicated opening scene pathway
"""

import json
import os
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_package(session_id="test-session"):
    """Build a minimal but valid OpeningStatePackage for testing."""
    from src.agents.session_zero_schemas import (
        OpeningStatePackage, PackageMetadata, PackageReadiness,
        PlayerCharacterBrief, OpeningSituation, OpeningCast,
        WorldContextBrief, ActiveThreadsBrief, CanonRules,
        ToneAndComposition, DirectorInputs, AnimationInputs,
        FactionContextBrief, PackageUncertainties,
    )
    return OpeningStatePackage(
        package_metadata=PackageMetadata(session_id=session_id, campaign_id=1),
        readiness=PackageReadiness(handoff_status="opening_package_ready"),
        player_character=PlayerCharacterBrief(name="Spike Spiegel", concept="Bounty hunter"),
        opening_situation=OpeningSituation(
            immediate_situation="Spike lounges in the Bebop cockpit",
            starting_location="Bebop spaceship",
            scene_question="Will Spike finally confront his past?",
        ),
        opening_cast=OpeningCast(),
        world_context=WorldContextBrief(setting_truths=["Humanity colonized the solar system"]),
        active_threads=ActiveThreadsBrief(),
        canon_rules=CanonRules(),
        tone_and_composition=ToneAndComposition(tension_source="unresolved past"),
        director_inputs=DirectorInputs(arc_seed_candidates=["The Long Goodbye"]),
        animation_inputs=AnimationInputs(),
        faction_context=FactionContextBrief(),
        uncertainties=PackageUncertainties(),
        hard_constraints=["Spike cannot remember Julia without pain"],
    )


# ---------------------------------------------------------------------------
# Schema roundtrip tests
# ---------------------------------------------------------------------------

class TestSessionZeroSchemas:
    """Verify schema serialization/deserialization roundtrips."""

    def test_opening_state_package_defaults(self):
        pkg = _make_package()
        assert pkg.player_character.name == "Spike Spiegel"
        # Roundtrip
        d = pkg.model_dump()
        from src.agents.session_zero_schemas import OpeningStatePackage
        pkg2 = OpeningStatePackage.model_validate(d)
        assert pkg2.player_character.name == "Spike Spiegel"
        assert pkg2.opening_situation.starting_location == "Bebop spaceship"

    def test_handoff_compiler_result_fields(self):
        from src.agents.session_zero_schemas import HandoffCompilerResult
        r = HandoffCompilerResult(success=True)
        assert r.compiler_task_id is None
        r2 = HandoffCompilerResult(success=False, compiler_task_id="abc-123", error="oops")
        assert r2.compiler_task_id == "abc-123"
        assert r2.error == "oops"

    def test_gap_analysis_output(self):
        from src.agents.session_zero_schemas import GapAnalysisOutput, UnresolvedItem, UnresolvedCategory
        gap = GapAnalysisOutput(
            handoff_safe=False,
            unresolved_items=[
                UnresolvedItem(
                    item_id="gap_001",
                    category=UnresolvedCategory.IDENTITY,
                    description="Character's primary motivation unclear",
                    why_it_matters="Affects arc direction",
                    priority="critical",
                    candidate_followup="What drives your character above all else?",
                )
            ],
            blocking_issues=["Character motivation undefined"],
            warnings=["Power tier inferred"],
            recommended_player_followups=["What drives your character?"],
        )
        assert not gap.handoff_safe
        assert gap.unresolved_items[0].priority == "critical"
        d = gap.model_dump()
        gap2 = GapAnalysisOutput.model_validate(d)
        assert gap2.unresolved_items[0].item_id == "gap_001"

    def test_entity_resolution_output(self):
        from src.agents.session_zero_schemas import (
            EntityResolutionOutput, EntityRecord, EntityType,
        )
        er = EntityResolutionOutput(
            canonical_entities=[
                EntityRecord(
                    canonical_id="ent_001",
                    entity_type=EntityType.CHARACTER,
                    display_name="Faye Valentine",
                    aliases=["Faye"],
                    confidence=0.95,
                )
            ],
            alias_map={"faye": "ent_001"},
        )
        assert er.canonical_entities[0].display_name == "Faye Valentine"
        assert er.alias_map["faye"] == "ent_001"

    def test_extraction_pass_output(self):
        from src.agents.session_zero_schemas import ExtractionPassOutput, FactRecord
        ep = ExtractionPassOutput(
            chunk_start_index=0,
            chunk_end_index=10,
            fact_records=[
                FactRecord(
                    fact_id="fact_001",
                    fact_type="backstory",
                    content="Spike was once a member of the Red Dragon Syndicate",
                    confidence=0.9,
                )
            ],
        )
        assert ep.fact_records[0].content.startswith("Spike")


# ---------------------------------------------------------------------------
# Artifact repository tests
# ---------------------------------------------------------------------------

class TestSessionZeroArtifactRepo:
    """Test the versioned artifact CRUD layer with in-memory SQLite."""

    @pytest.fixture(autouse=True)
    def setup_db(self, fresh_db):
        """Ensure new tables exist in the test DB."""
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

    def test_create_and_complete_run(self):
        from src.db.session_zero_artifacts import create_run, complete_run
        from src.db.session import get_session

        with get_session() as db:
            run = create_run(db, session_id="sess_001", run_type="full_compile")
            assert run.id is not None
            assert run.status == "running"
            complete_run(db, run, checkpoints=[{"step": "extraction"}])
            assert run.status == "completed"

    def test_fail_run(self):
        from src.db.session_zero_artifacts import create_run, fail_run
        from src.db.session import get_session

        with get_session() as db:
            run = create_run(db, session_id="sess_002", run_type="full_compile")
            fail_run(db, run, error="LLM timeout")
            assert run.status == "failed"
            assert run.error_message == "LLM timeout"

    def test_save_artifact_and_dedup(self):
        from src.db.session_zero_artifacts import (
            save_artifacts_transactional,
            get_active_artifact, load_artifact_content,
        )
        from src.db.session import get_session

        content = {"player_character": {"name": "Ed"}, "readiness": {"handoff_status": "opening_package_ready"}}
        _run1, artifacts = save_artifacts_transactional(
            session_id="sess_003",
            artifacts={"opening_state_package": content},
            run_type="full_compile",
        )
        assert "opening_state_package" in artifacts

        # Second save with same content should be a no-op (dedup)
        _run2, artifacts2 = save_artifacts_transactional(
            session_id="sess_003",
            artifacts={"opening_state_package": content},
            run_type="full_compile",
        )
        assert artifacts["opening_state_package"].transcript_hash == artifacts2["opening_state_package"].transcript_hash

        # Load back via DB session
        with get_session() as db:
            artifact = get_active_artifact(db, "sess_003", "opening_state_package")
            assert artifact is not None
            loaded = load_artifact_content(artifact)
        assert loaded["player_character"]["name"] == "Ed"

    def test_save_artifact_force_new_version(self):
        from src.db.session_zero_artifacts import save_artifacts_transactional

        content = {"player_character": {"name": "Jet"}}
        _, first = save_artifacts_transactional(
            "sess_004", {"gap_analysis": content}, run_type="full_compile",
        )
        # Save again — dedup means same version is returned (same content)
        _, second = save_artifacts_transactional(
            "sess_004", {"gap_analysis": content}, run_type="full_compile",
        )
        assert first["gap_analysis"].id == second["gap_analysis"].id

    def test_compute_hashes(self):
        from src.db.session_zero_artifacts import compute_transcript_hash, compute_draft_hash
        messages = [{"role": "user", "content": "I want to play as Spike"}]
        h1 = compute_transcript_hash(messages)
        h2 = compute_transcript_hash(messages)
        assert h1 == h2
        assert len(h1) == 64  # SHA-256 hexdigest is 64 chars

        draft = {"name": "Spike", "concept": "Bounty hunter"}
        dh = compute_draft_hash(draft)
        assert isinstance(dh, str)
        assert len(dh) == 64  # SHA-256 hexdigest is 64 chars


# ---------------------------------------------------------------------------
# HandoffCompiler pipeline tests (mocked LLM)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
class TestHandoffCompiler:
    """Test the 4-pass compiler pipeline using queued mock LLM responses."""

    def _make_minimal_messages(self) -> list[dict]:
        return [
            {"role": "assistant", "content": "Tell me about your character."},
            {"role": "user", "content": "I want to play as Spike Spiegel from Cowboy Bebop."},
            {"role": "assistant", "content": "Great! What's Spike's core motivation?"},
            {"role": "user", "content": "He's haunted by his past with the Red Dragon Syndicate."},
            {"role": "assistant", "content": "Where does the story begin?"},
            {"role": "user", "content": "On the Bebop, just after a failed bounty attempt."},
        ]

    def _queue_full_pipeline_responses(self, mock_provider, session_id="test-session"):
        """Queue one valid response per compiler pass."""
        from src.agents.session_zero_schemas import (
            ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
        )
        mock_provider.queue_schema_response(ExtractionPassOutput(
            chunk_start_index=0, chunk_end_index=6,
        ))
        mock_provider.queue_schema_response(EntityResolutionOutput())
        mock_provider.queue_schema_response(GapAnalysisOutput(handoff_safe=True))
        mock_provider.queue_schema_response(_make_package(session_id))

    async def test_compiler_run_success(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        self._queue_full_pipeline_responses(mock_provider)

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            compiler = HandoffCompiler(
                session_id="test-session",
                messages=self._make_minimal_messages(),
                character_draft={"name": "Spike Spiegel"},
                campaign_id=1,
            )
            result = await compiler.run()

        assert result.success
        assert result.opening_state_package is not None
        assert result.opening_state_package.player_character.name == "Spike Spiegel"
        assert result.compiler_task_id is not None
        assert result.gap_analysis is not None
        assert result.gap_analysis.handoff_safe

    async def test_compiler_run_failure_is_non_blocking(self, mock_provider, fresh_db):
        """Compiler failure should return HandoffCompilerResult(success=False), not raise."""
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        mock_provider.reset()

        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            compiler = HandoffCompiler(
                session_id="test-fail",
                messages=self._make_minimal_messages(),
                character_draft={},
                campaign_id=1,
            )
            # Make the extractor raise
            compiler._extractor.extract_chunk = AsyncMock(side_effect=RuntimeError("LLM error"))
            result = await compiler.run()

        assert not result.success
        assert result.error is not None
        assert "LLM error" in result.error
        assert result.compiler_task_id is not None

    async def test_compiler_progress_tracker_emits_events(self, mock_provider, fresh_db):
        """ProgressTracker should accumulate events through all phases."""
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        self._queue_full_pipeline_responses(mock_provider, session_id="test-progress")

        # Capture the ProgressTracker instance before it's cleaned up on complete()
        from src.agents.progress import ProgressTracker, ProgressPhase
        captured = []
        original_init = ProgressTracker.__init__

        def capturing_init(self, *args, **kwargs):
            original_init(self, *args, **kwargs)
            captured.append(self)

        with patch("src.agents.base.get_llm_manager") as mock_mgr, \
             patch.object(ProgressTracker, "__init__", capturing_init):
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            compiler = HandoffCompiler(
                session_id="test-progress",
                messages=self._make_minimal_messages(),
                character_draft={},
                campaign_id=1,
            )
            result = await compiler.run()

        assert result.success
        assert len(captured) == 1
        tracker = captured[0]
        phases_seen = {e.phase for e in tracker.events}
        assert ProgressPhase.INITIALIZING in phases_seen
        assert ProgressPhase.COMPLETE in phases_seen
        assert len(tracker.events) >= 5


# ---------------------------------------------------------------------------
# DirectorAgent._build_startup_context tests
# ---------------------------------------------------------------------------

class TestDirectorStartupContext:
    """Verify _build_startup_context produces correct output for both paths."""

    def _make_profile(self):
        from src.profiles.loader import NarrativeProfile
        try:
            return NarrativeProfile.model_validate({
                "title": "Cowboy Bebop",
                "profile_id": "cowboy_bebop",
                "director_personality": "You are a noir director.",
                "dna": {"action_vs_drama": 7, "light_vs_dark": 3},
                "tropes": {"found_family": True},
                "author_voice": {"tone": "melancholic"},
            })
        except Exception:
            p = MagicMock()
            p.dna = {"action_vs_drama": 7}
            p.tropes = {}
            p.director_personality = "noir director"
            p.author_voice = None
            p.voice_cards = None
            p.detected_genres = None
            return p

    def test_legacy_path_contains_summary(self):
        from src.agents.director import DirectorAgent
        agent = DirectorAgent.__new__(DirectorAgent)
        profile = self._make_profile()
        ctx = agent._build_startup_context(
            session_zero_summary="Character created: Spike Spiegel, bounty hunter.",
            profile=profile,
            character_name="Spike Spiegel",
            character_concept="Former syndicate hitman",
            starting_location="Bebop",
            power_tier="street",
            tension_source=None,
            power_expression=None,
            narrative_focus=None,
            composition_name=None,
            opening_state_package=None,
        )
        assert "Spike Spiegel" in ctx
        assert "Character created" in ctx
        assert "Session Zero Summary" in ctx

    def test_package_path_uses_structured_data(self):
        from src.agents.director import DirectorAgent
        agent = DirectorAgent.__new__(DirectorAgent)
        profile = self._make_profile()
        pkg = _make_package()
        ctx = agent._build_startup_context(
            session_zero_summary="Some old summary",
            profile=profile,
            character_name="Spike Spiegel",
            character_concept="...",
            starting_location="...",
            power_tier=None,
            tension_source=None,
            power_expression=None,
            narrative_focus=None,
            composition_name=None,
            opening_state_package=pkg,
        )
        assert "Spike Spiegel" in ctx
        assert "Bebop spaceship" in ctx
        assert "Will Spike finally confront his past?" in ctx
        assert "The Long Goodbye" in ctx
        assert "unresolved past" in ctx
        assert "Spike cannot remember Julia without pain" in ctx
        assert "Supplementary" in ctx or "supplementary" in ctx.lower() or "Summary" in ctx

    def test_package_path_no_crash_on_empty_sections(self):
        """Package path should not raise even when optional sections have no data."""
        from src.agents.director import DirectorAgent
        from src.agents.session_zero_schemas import (
            OpeningStatePackage, PackageMetadata, PackageReadiness,
            PlayerCharacterBrief, OpeningSituation, OpeningCast,
            WorldContextBrief, ActiveThreadsBrief, CanonRules,
            ToneAndComposition, DirectorInputs, AnimationInputs,
            FactionContextBrief, PackageUncertainties,
        )
        agent = DirectorAgent.__new__(DirectorAgent)
        profile = self._make_profile()
        pkg = OpeningStatePackage(
            package_metadata=PackageMetadata(session_id="s", campaign_id=1),
            readiness=PackageReadiness(handoff_status="opening_package_ready"),
            player_character=PlayerCharacterBrief(),
            opening_situation=OpeningSituation(),
            opening_cast=OpeningCast(),
            world_context=WorldContextBrief(),
            active_threads=ActiveThreadsBrief(),
            canon_rules=CanonRules(),
            tone_and_composition=ToneAndComposition(),
            director_inputs=DirectorInputs(),
            animation_inputs=AnimationInputs(),
            faction_context=FactionContextBrief(),
            uncertainties=PackageUncertainties(),
        )
        ctx = agent._build_startup_context(
            session_zero_summary="",
            profile=profile,
            character_name="",
            character_concept="",
            starting_location="",
            power_tier=None,
            tension_source=None,
            power_expression=None,
            narrative_focus=None,
            composition_name=None,
            opening_state_package=pkg,
        )
        assert "Pilot Episode Planning" in ctx


# ---------------------------------------------------------------------------
# KeyAnimator.generate_opening_scene tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
class TestKeyAnimatorOpeningScene:
    """Test the dedicated opening scene generation pathway."""

    def _make_profile(self):
        p = MagicMock()
        p.dna = {"action_vs_drama": 6}
        return p

    def _make_ka(self, mock_provider):
        from src.agents.key_animator import KeyAnimator
        ka = KeyAnimator.__new__(KeyAnimator)
        ka._model_override = None
        ka._cached_provider = mock_provider
        ka._cached_model = "mock-model"
        return ka

    async def test_generate_opening_scene_returns_narrative(self, mock_provider):
        """generate_opening_scene returns (narrative, portrait_map) tuple."""
        expected = "### 🌌 Blue Screen\n\nSmoke curled from a forgotten cigarette. **Spike** stared into the void."
        mock_provider.queue_response(expected)
        ka = self._make_ka(mock_provider)

        with patch("src.media.resolver.resolve_portraits", return_value=(expected, {})):
            narrative, portrait_map = await ka.generate_opening_scene(
                opening_state_package=_make_package(),
                director_output=None,
                profile=self._make_profile(),
                campaign_id=1,
            )

        assert "Spike" in narrative
        assert isinstance(portrait_map, dict)

    async def test_generate_opening_scene_with_director_output(self, mock_provider):
        """Director notes should appear in the context block."""
        ka = self._make_ka(mock_provider)

        director_output = MagicMock()
        director_output.director_notes = "Open on a wide shot of the ship."
        director_output.current_arc = "The Long Goodbye"
        director_output.active_foreshadowing = [{"symbol": "A red eye"}]

        pkg = _make_package()
        profile = self._make_profile()

        context = ka._build_opening_scene_context(pkg, director_output, profile)
        assert "Open on a wide shot of the ship." in context
        assert "The Long Goodbye" in context
        assert "A red eye" in context
        assert "Spike Spiegel" in context
        assert "unresolved past" in context
        assert "Spike cannot remember Julia without pain" in context

    async def test_generate_opening_scene_portrait_resolution_failure_is_safe(self, mock_provider):
        """Portrait resolution failure should not crash the opening scene."""
        expected = "Opening scene text with **Spike** in it."
        mock_provider.queue_response(expected)
        ka = self._make_ka(mock_provider)

        with patch("src.media.resolver.resolve_portraits", side_effect=Exception("DB error")):
            narrative, portrait_map = await ka.generate_opening_scene(
                opening_state_package=_make_package(),
                director_output=None,
                profile=self._make_profile(),
                campaign_id=1,
            )

        assert narrative == expected
        assert portrait_map == {}
