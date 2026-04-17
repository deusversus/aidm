"""Tests for safe replay of idempotent post-narrative bookkeeping.

Exercises:
  - No-op when the orchestrator has no incomplete turn
  - Idempotent steps (entity_graph_snapshot, memory_heat_decay) get replayed
  - Already-completed steps are NOT re-run
  - Non-idempotent steps land in skipped_steps with a reason
  - Errors in a replay step surface in the result but don't abort
  - Checkpoint is updated with merged completed_steps on success
  - background_completed flips to True only when all idempotent steps cover
"""

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import pytest

from src.core.turn_replay import (
    _IDEMPOTENT_STEPS,
    _NON_IDEMPOTENT_SKIP_REASON,
    replay_safe_bookkeeping,
)
from src.db.session import get_session
from src.db.session_zero_artifacts import (
    get_active_artifact,
    load_artifact_content,
    save_artifact,
)


def _make_stub_orchestrator(campaign_id: int, incomplete_turn: dict | None):
    """Minimal orchestrator stand-in. Replay only touches the attrs used
    inside replay_safe_bookkeeping."""
    stub = SimpleNamespace()
    stub.campaign_id = campaign_id
    stub.incomplete_turn = incomplete_turn
    stub._bg_save_entity_graph = AsyncMock()
    stub.memory = MagicMock()
    stub.memory.decay_heat = MagicMock()
    stub.memory.add_episode = MagicMock(return_value="mock-id")
    return stub


async def test_returns_none_when_no_incomplete_turn():
    stub = _make_stub_orchestrator(91101, incomplete_turn=None)
    result = await replay_safe_bookkeeping(stub)
    assert result is None


async def test_replays_missing_idempotent_steps(fresh_db):
    campaign_id = 91102
    # Pretend the prior checkpoint finished the transactional block but
    # crashed before the idempotent tail steps ran.
    with get_session() as db:
        save_artifact(
            db, str(campaign_id), "gameplay_turn_checkpoint",
            {
                "turn_number": 4,
                "background_completed": False,
                "completed_steps": ["transactional_block"],
                "intent": "EXPLORE",
                "player_input_preview": "I investigate the chest",
                "narrative_preview": "The chest creaks open...",
            },
        )

    stub = _make_stub_orchestrator(
        campaign_id,
        incomplete_turn={
            "turn_number": 4,
            "completed_steps": ["transactional_block"],
            "player_input_preview": "I investigate the chest",
            "narrative_preview": "The chest creaks open...",
        },
    )

    result = await replay_safe_bookkeeping(stub)

    assert result is not None
    assert result.turn_number == 4
    assert set(result.replayed_steps) == set(_IDEMPOTENT_STEPS)
    assert result.errors == {}
    assert result.checkpoint_updated is True
    stub._bg_save_entity_graph.assert_awaited_once()
    stub.memory.decay_heat.assert_called_once_with(4)
    # Episode write happens with the checkpoint previews collapsed into a summary.
    stub.memory.add_episode.assert_called_once()
    kwargs = stub.memory.add_episode.call_args.kwargs
    assert kwargs["turn"] == 4
    assert "chest" in kwargs["summary"]

    # Checkpoint now reflects the merged completed_steps and flips to done
    # because the idempotent cover set is now complete.
    with get_session() as db:
        latest = get_active_artifact(db, str(campaign_id), "gameplay_turn_checkpoint")
        data = load_artifact_content(latest)
    assert data["background_completed"] is True
    assert set(data["completed_steps"]) >= set(_IDEMPOTENT_STEPS) | {"transactional_block"}
    assert stub.incomplete_turn is None  # Flag cleared on full recovery


async def test_does_not_rerun_already_completed_steps(fresh_db):
    campaign_id = 91103
    stub = _make_stub_orchestrator(
        campaign_id,
        incomplete_turn={
            "turn_number": 7,
            # Everything idempotent was already done; only transactional block
            # was missing — which replay must NOT touch.
            "completed_steps": list(_IDEMPOTENT_STEPS),
        },
    )

    result = await replay_safe_bookkeeping(stub)

    assert result is not None
    assert result.replayed_steps == []   # Nothing to redo
    stub._bg_save_entity_graph.assert_not_awaited()
    stub.memory.decay_heat.assert_not_called()


async def test_non_idempotent_steps_show_up_in_skipped_with_reasons(fresh_db):
    campaign_id = 91104
    stub = _make_stub_orchestrator(
        campaign_id,
        incomplete_turn={"turn_number": 3, "completed_steps": []},
    )

    result = await replay_safe_bookkeeping(stub)

    assert result is not None
    # Every non-idempotent step that didn't already complete should be
    # surfaced with an explanation.
    for step in _NON_IDEMPOTENT_SKIP_REASON:
        assert step in result.skipped_steps, f"{step} should be in skipped"
        assert result.skipped_steps[step]  # non-empty reason


async def test_step_errors_surface_without_aborting(fresh_db):
    campaign_id = 91105
    stub = _make_stub_orchestrator(
        campaign_id,
        incomplete_turn={"turn_number": 9, "completed_steps": []},
    )
    # Make the first idempotent step explode; the second must still run.
    stub._bg_save_entity_graph = AsyncMock(side_effect=RuntimeError("snap boom"))

    result = await replay_safe_bookkeeping(stub)

    assert result is not None
    assert "entity_graph_snapshot" in result.errors
    assert "snap boom" in result.errors["entity_graph_snapshot"]
    # Heat decay still ran despite the earlier failure.
    stub.memory.decay_heat.assert_called_once_with(9)
    assert "memory_heat_decay" in result.replayed_steps


async def test_partial_replay_leaves_flag_set(fresh_db):
    """If not every idempotent step succeeds, background_completed stays False
    so the banner keeps surfacing until an operator resolves."""
    campaign_id = 91106
    stub = _make_stub_orchestrator(
        campaign_id,
        incomplete_turn={"turn_number": 2, "completed_steps": []},
    )
    stub._bg_save_entity_graph = AsyncMock(side_effect=RuntimeError("fail"))

    result = await replay_safe_bookkeeping(stub)

    assert result is not None
    assert result.errors  # At least one step failed

    with get_session() as db:
        latest = get_active_artifact(db, str(campaign_id), "gameplay_turn_checkpoint")
        data = load_artifact_content(latest)
    assert data["background_completed"] is False
