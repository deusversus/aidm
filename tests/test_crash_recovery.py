"""Tests for Orchestrator._check_incomplete_turns() crash-recovery reader.

Verifies the reader correctly classifies checkpoint artifacts:
  - background_completed=False → warn + return data
  - background_completed=True  → silent + return None
  - no checkpoint              → silent + return None

Regression coverage for the pre-fix bug where the reader silently swallowed
an AttributeError (SessionZeroArtifact.content vs .content_json) and never
actually detected incomplete turns.
"""

import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import pytest

from src.core.orchestrator import Orchestrator
from src.db.session import get_session
from src.db.session_zero_artifacts import save_artifact


def _run_check(campaign_id: int) -> dict | None:
    """Invoke the reader without building a full Orchestrator."""
    fake = SimpleNamespace(campaign_id=campaign_id)
    return Orchestrator._check_incomplete_turns(fake)


def test_no_checkpoint_returns_none():
    assert _run_check(90001) is None


def test_completed_turn_returns_none():
    with get_session() as db:
        save_artifact(
            db, "90002", "gameplay_turn_checkpoint",
            {"turn_number": 7, "background_completed": True},
        )
    assert _run_check(90002) is None


def test_incomplete_turn_returns_data(caplog):
    with get_session() as db:
        save_artifact(
            db, "90003", "gameplay_turn_checkpoint",
            {
                "turn_number": 12,
                "background_completed": False,
                "intent": "attack",
                "memory_provenance": {"turn": 12},
            },
        )

    with caplog.at_level("WARNING"):
        data = _run_check(90003)

    assert data is not None
    assert data["turn_number"] == 12
    assert data["background_completed"] is False
    assert data["intent"] == "attack"
    assert any("CRASH RECOVERY" in r.message for r in caplog.records)


def test_latest_checkpoint_wins():
    """If the most recent checkpoint is completed, no recovery is flagged
    even if an older incomplete checkpoint exists."""
    with get_session() as db:
        save_artifact(
            db, "90004", "gameplay_turn_checkpoint",
            {"turn_number": 1, "background_completed": False},
        )
        save_artifact(
            db, "90004", "gameplay_turn_checkpoint",
            {"turn_number": 2, "background_completed": True},
        )

    assert _run_check(90004) is None
