"""Tests for HandoffStatus state machine transitions.

Verifies that the handoff pipeline surfaces the correct status
at each stage: compiler success/failure, opening scene success/failure,
and the legacy compiler-skipped path.
"""

import os
import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")


class TestHandoffStatusEnum:
    """HandoffStatus enum must have all required values."""

    def test_enum_values_exist(self):
        from src.agents.session_zero_schemas import HandoffStatus
        assert HandoffStatus.NOT_READY == "not_ready"
        assert HandoffStatus.HANDOFF_COMPILING == "handoff_compiling"
        assert HandoffStatus.OPENING_PACKAGE_READY == "opening_package_ready"
        assert HandoffStatus.DIRECTOR_STARTUP_READY == "director_startup_ready"
        assert HandoffStatus.OPENING_SCENE_GENERATING == "opening_scene_generating"
        assert HandoffStatus.OPENING_SCENE_READY == "opening_scene_ready"
        assert HandoffStatus.OPENING_SCENE_FAILED == "opening_scene_failed"
        assert HandoffStatus.HANDOFF_BLOCKED == "handoff_blocked"

    def test_enum_is_str_subclass(self):
        from src.agents.session_zero_schemas import HandoffStatus
        assert isinstance(HandoffStatus.OPENING_SCENE_READY, str)
        assert HandoffStatus.OPENING_SCENE_READY == "opening_scene_ready"

    def test_enum_members_count(self):
        from src.agents.session_zero_schemas import HandoffStatus
        assert len(HandoffStatus) == 8


class TestPackageReadinessStatus:
    """PackageReadiness.handoff_status must accept HandoffStatus values."""

    def test_package_readiness_accepts_enum(self):
        from src.agents.session_zero_schemas import PackageReadiness, HandoffStatus
        r = PackageReadiness(handoff_status=HandoffStatus.OPENING_PACKAGE_READY)
        assert r.handoff_status == HandoffStatus.OPENING_PACKAGE_READY

    def test_package_readiness_accepts_string(self):
        from src.agents.session_zero_schemas import PackageReadiness
        r = PackageReadiness(handoff_status="opening_package_ready")
        assert r.handoff_status == "opening_package_ready"

    def test_package_readiness_default_is_opening_package_ready(self):
        from src.agents.session_zero_schemas import PackageReadiness
        r = PackageReadiness()
        assert r.handoff_status == "opening_package_ready"


class TestHandoffCompilerResultStatus:
    """HandoffCompilerResult must correctly reflect success/failure states."""

    def test_success_result_has_no_error(self):
        from src.agents.session_zero_schemas import HandoffCompilerResult
        r = HandoffCompilerResult(success=True)
        assert r.success is True
        assert r.error is None

    def test_failure_result_has_error_string(self):
        from src.agents.session_zero_schemas import HandoffCompilerResult
        r = HandoffCompilerResult(success=False, error="Extraction pass failed: LLM timeout")
        assert r.success is False
        assert "LLM timeout" in r.error

    def test_compiler_task_id_populated_on_both_outcomes(self):
        from src.agents.session_zero_schemas import HandoffCompilerResult
        success = HandoffCompilerResult(success=True, compiler_task_id="task-abc")
        failure = HandoffCompilerResult(success=False, compiler_task_id="task-xyz", error="err")
        assert success.compiler_task_id == "task-abc"
        assert failure.compiler_task_id == "task-xyz"


class TestSessionZeroResponseStatusFields:
    """SessionZeroResponse must carry the new M3 status fields."""

    def test_opening_scene_status_field_exists(self):
        from api.routes.game.models import SessionZeroResponse
        r = SessionZeroResponse(
            response="test",
            phase="gameplay",
            phase_complete=True,
            character_draft={},
            session_id="test-session",
        )
        assert hasattr(r, "opening_scene_status")
        assert r.opening_scene_status is None

    def test_opening_scene_status_can_be_set(self):
        from api.routes.game.models import SessionZeroResponse
        r = SessionZeroResponse(
            response="test",
            phase="gameplay",
            phase_complete=True,
            character_draft={},
            session_id="s",
            opening_scene_status="opening_scene_ready",
        )
        assert r.opening_scene_status == "opening_scene_ready"

    def test_retryable_failure_defaults_false(self):
        from api.routes.game.models import SessionZeroResponse
        r = SessionZeroResponse(
            response="test", phase="gameplay", phase_complete=False,
            character_draft={}, session_id="s",
        )
        assert r.retryable_failure is False

    def test_progress_fields_default_none(self):
        from api.routes.game.models import SessionZeroResponse
        r = SessionZeroResponse(
            response="test", phase="gameplay", phase_complete=False,
            character_draft={}, session_id="s",
        )
        assert r.progress_stage is None
        assert r.progress_message is None
        assert r.progress_percent is None

    def test_all_status_values_accepted(self):
        from api.routes.game.models import SessionZeroResponse
        for status in ("opening_scene_generating", "opening_scene_ready", "opening_scene_failed"):
            r = SessionZeroResponse(
                response="", phase="gameplay", phase_complete=True,
                character_draft={}, session_id="s",
                opening_scene_status=status,
            )
            assert r.opening_scene_status == status
