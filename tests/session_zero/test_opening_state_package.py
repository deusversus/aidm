"""Tests for OpeningStatePackage assembly from fixture transcripts.

Verifies that representative transcript fixtures produce valid
OpeningStatePackage outputs when run through HandoffCompiler with a
MockLLMProvider — no real LLM calls required.

Covers M2 test gates: F1 (minimal), F2 (dense freeform),
F4 (canon divergence), F9 (opening-scene-sensitive).
"""

import json
import os
import pytest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name) as f:
        return json.load(f)


def _make_package_response(session_id: str, character_name: str, starting_location: str):
    """Build a minimal OpeningStatePackage for the mock schema queue."""
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
        player_character=PlayerCharacterBrief(name=character_name, concept="test character"),
        opening_situation=OpeningSituation(
            immediate_situation="The story begins",
            starting_location=starting_location,
            scene_question="What will happen next?",
        ),
        opening_cast=OpeningCast(),
        world_context=WorldContextBrief(setting_truths=["Anime world rules apply"]),
        active_threads=ActiveThreadsBrief(),
        canon_rules=CanonRules(),
        tone_and_composition=ToneAndComposition(tension_source="external threat"),
        director_inputs=DirectorInputs(arc_seed_candidates=["The First Test"]),
        animation_inputs=AnimationInputs(),
        faction_context=FactionContextBrief(),
        uncertainties=PackageUncertainties(),
    )


def _queue_full_pipeline(mock_provider, session_id: str, character_name: str, location: str):
    from src.agents.session_zero_schemas import (
        ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
    )
    mock_provider.queue_schema_response(ExtractionPassOutput(chunk_start_index=0, chunk_end_index=8))
    mock_provider.queue_schema_response(EntityResolutionOutput())
    mock_provider.queue_schema_response(GapAnalysisOutput(handoff_safe=True))
    mock_provider.queue_schema_response(
        _make_package_response(session_id, character_name, location)
    )


@pytest.mark.asyncio
class TestOpeningStatePackageFromFixtures:
    """Compiler produces valid OpeningStatePackage for each fixture transcript."""

    async def _run_compiler(self, mock_provider, fixture_name: str, session_id: str):
        fixture = _load_fixture(fixture_name)
        draft = fixture["character_draft"]
        _queue_full_pipeline(
            mock_provider,
            session_id=session_id,
            character_name=draft.get("name", "TestChar"),
            location=draft.get("starting_location", "Unknown"),
        )
        with patch("src.agents.base.get_llm_manager") as mock_mgr:
            mock_mgr.return_value.get_provider_for_agent.return_value = (mock_provider, "mock-model")
            from src.core.session_zero_compiler import HandoffCompiler
            compiler = HandoffCompiler(
                session_id=session_id,
                messages=fixture["messages"],
                character_draft=draft,
                campaign_id=1,
            )
            return await compiler.run()

    async def test_f1_minimal_guided(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(mock_provider, "f1_minimal_guided.json", "f1-session")

        assert result.success, f"Compiler failed: {result.error}"
        pkg = result.opening_state_package
        assert pkg is not None
        assert pkg.player_character.name == "Jet Black"
        assert pkg.opening_situation.starting_location != ""
        assert result.gap_analysis is not None

    async def test_f2_dense_freeform(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(mock_provider, "f2_dense_freeform.json", "f2-session")

        assert result.success, f"Compiler failed: {result.error}"
        pkg = result.opening_state_package
        assert pkg is not None
        assert pkg.player_character is not None
        assert pkg.opening_situation is not None

    async def test_f4_canon_divergence(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(mock_provider, "f4_canon_divergence.json", "f4-session")

        assert result.success, f"Compiler failed: {result.error}"
        pkg = result.opening_state_package
        assert pkg is not None
        # Canon divergence fixture — package should still be valid
        assert pkg.player_character is not None

    async def test_f9_opening_scene_sensitive(self, mock_provider, fresh_db):
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(
            mock_provider, "f9_opening_scene_sensitive.json", "f9-session"
        )

        assert result.success, f"Compiler failed: {result.error}"
        pkg = result.opening_state_package
        assert pkg is not None
        assert pkg.opening_situation is not None

    async def test_package_metadata_has_session_id(self, mock_provider, fresh_db):
        """Package metadata must record the correct session_id."""
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(mock_provider, "f1_minimal_guided.json", "meta-check-session")

        assert result.success
        assert result.opening_state_package.package_metadata.session_id == "meta-check-session"

    async def test_package_roundtrips_json(self, mock_provider, fresh_db):
        """OpeningStatePackage from compiler survives model_dump/model_validate roundtrip."""
        from src.db.models import Base
        from src.db.session import get_engine
        Base.metadata.create_all(bind=get_engine())

        result = await self._run_compiler(mock_provider, "f1_minimal_guided.json", "roundtrip-session")

        assert result.success
        pkg = result.opening_state_package
        from src.agents.session_zero_schemas import OpeningStatePackage
        pkg2 = OpeningStatePackage.model_validate(pkg.model_dump())
        assert pkg2.player_character.name == pkg.player_character.name
        assert pkg2.package_metadata.session_id == pkg.package_metadata.session_id
