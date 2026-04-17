"""Tests for cold-start combat replay from a persisted checkpoint.

The crash-recovery path needs to survive a process restart. The
pre-background checkpoint now serializes:

  - combat_occurred: bool
  - combat_result_payload: CombatResult.model_dump()
  - combat_target_name: str
  - outcome_payload: OutcomeOutput.model_dump()

so that ``_replay_combat_bookkeeping`` can rehydrate the combat result
and re-apply it in a fresh orchestrator instance under the per-turn
idempotency guard on ``characters.last_combat_applied_turn``.

Also covers the latent target-name bug that made pre-patch combat
bookkeeping a silent no-op: CombatResult has no ``target_name`` field,
so ``getattr(combat_result, 'target_name', None)`` always returned None
and ``state.get_target(None)`` never resolved the victim. The fix
stores target_name separately on the orchestrator instance AND in the
checkpoint.
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import pytest

from src.agents.combat import CombatResult
from src.core.turn_replay import _replay_combat_bookkeeping


def _make_stub(incomplete_turn: dict | None, character=None, target=None):
    stub = SimpleNamespace()
    stub.incomplete_turn = incomplete_turn
    stub.state = MagicMock()
    stub.state.get_character.return_value = character
    stub.state.get_target.return_value = target
    stub.state.apply_combat_result = MagicMock()
    stub.state._get_db = MagicMock(return_value=MagicMock())
    return stub


def test_replay_noop_when_combat_did_not_occur():
    stub = _make_stub({"turn_number": 4, "combat_occurred": False})
    assert _replay_combat_bookkeeping(stub, 4) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_noop_when_payload_missing():
    """Older checkpoints (pre-012) won't carry combat_result_payload."""
    stub = _make_stub(
        {"turn_number": 4, "combat_occurred": True, "combat_target_name": "Goblin"},
    )
    assert _replay_combat_bookkeeping(stub, 4) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_noop_when_target_name_missing():
    stub = _make_stub(
        {
            "turn_number": 4,
            "combat_occurred": True,
            "combat_result_payload": CombatResult(damage_dealt=10).model_dump(),
        },
    )
    assert _replay_combat_bookkeeping(stub, 4) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_noop_when_damage_is_zero():
    """Missed attacks don't need replay — nothing to re-apply."""
    character = MagicMock(last_combat_applied_turn=None)
    target = MagicMock()
    stub = _make_stub(
        {
            "turn_number": 4,
            "combat_occurred": True,
            "combat_target_name": "Goblin",
            "combat_result_payload": CombatResult(damage_dealt=0, hit=False).model_dump(),
        },
        character=character,
        target=target,
    )
    assert _replay_combat_bookkeeping(stub, 4) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_applies_when_everything_present_and_guard_clear():
    """Happy path: checkpoint has full payload, guard not yet set, damage > 0."""
    character = MagicMock(last_combat_applied_turn=None)
    target = MagicMock()
    stub = _make_stub(
        {
            "turn_number": 9,
            "combat_occurred": True,
            "combat_target_name": "Shadow Drake",
            "combat_result_payload": CombatResult(
                damage_dealt=42, hit=True, damage_type="fire",
            ).model_dump(),
        },
        character=character,
        target=target,
    )
    assert _replay_combat_bookkeeping(stub, 9) is True
    stub.state.apply_combat_result.assert_called_once()
    args, kwargs = stub.state.apply_combat_result.call_args
    applied_result = args[0]
    assert isinstance(applied_result, CombatResult)
    assert applied_result.damage_dealt == 42
    assert args[1] is target
    # Marker got stamped so a second replay would no-op.
    assert character.last_combat_applied_turn == 9


def test_replay_guard_prevents_double_apply():
    """If the guard says the turn already landed, replay must NOT re-apply."""
    character = MagicMock(last_combat_applied_turn=9)   # Already stamped
    target = MagicMock()
    stub = _make_stub(
        {
            "turn_number": 9,
            "combat_occurred": True,
            "combat_target_name": "Shadow Drake",
            "combat_result_payload": CombatResult(damage_dealt=42).model_dump(),
        },
        character=character,
        target=target,
    )
    assert _replay_combat_bookkeeping(stub, 9) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_noop_when_character_or_target_missing():
    """get_target/get_character returning None must not crash; just log and skip."""
    stub = _make_stub(
        {
            "turn_number": 9,
            "combat_occurred": True,
            "combat_target_name": "Ghost",
            "combat_result_payload": CombatResult(damage_dealt=5).model_dump(),
        },
        character=None,   # No character loaded
        target=None,
    )
    assert _replay_combat_bookkeeping(stub, 9) is False
    stub.state.apply_combat_result.assert_not_called()


def test_replay_handles_malformed_payload():
    """A bogus payload dict must not crash replay; it's best-effort."""
    stub = _make_stub(
        {
            "turn_number": 9,
            "combat_occurred": True,
            "combat_target_name": "Goblin",
            "combat_result_payload": {"damage_dealt": "not-an-int", "hit": "whoops"},
        },
        character=MagicMock(last_combat_applied_turn=None),
        target=MagicMock(),
    )
    assert _replay_combat_bookkeeping(stub, 9) is False
    stub.state.apply_combat_result.assert_not_called()
