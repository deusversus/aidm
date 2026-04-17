"""Tests for the per-turn idempotency guards on absolute-delta bookkeeping.

The ``character.last_combat_applied_turn`` and
``character.last_progression_applied_turn`` columns ensure that combat
HP/MP changes and XP/level-up awards are only applied ONCE per turn,
even when post-narrative processing runs more than once for the same
(campaign_id, turn_number) — e.g. if an operator manually retries
background bookkeeping via the replay endpoint, or if the ``_bg_lock``
briefly permits a second entry under error recovery.

These tests hit the guard directly at the ORM level so we don't depend
on the full orchestrator pipeline.
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import pytest

from src.db.models import Character
from src.db.session import get_session


def _make_character(fresh_db, hp: int = 100, xp: int = 0) -> int:
    """Create a minimal campaign + character, return character.id."""
    from src.db.models import Campaign
    with get_session() as db:
        camp = Campaign(name="GuardTest", profile_id="test")
        db.add(camp)
        db.flush()
        char = Character(
            campaign_id=camp.id,
            name="Guard Tester",
            hp_current=hp,
            hp_max=100,
            xp_current=xp,
        )
        db.add(char)
        db.flush()
        return char.id


def test_combat_guard_prevents_double_apply(fresh_db):
    """The guard pattern from _background.py step 2, in isolation."""
    char_id = _make_character(fresh_db, hp=100)
    turn = 12

    # First application
    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        assert char.last_combat_applied_turn is None
        if char.last_combat_applied_turn != turn:
            char.hp_current -= 25  # Simulate damage
            char.last_combat_applied_turn = turn

    # Second application (same turn, same guard)
    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        assert char.hp_current == 75
        if char.last_combat_applied_turn != turn:
            char.hp_current -= 25  # Would double-damage — guard prevents
            char.last_combat_applied_turn = turn

    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        assert char.hp_current == 75  # Unchanged; double-apply blocked
        assert char.last_combat_applied_turn == 12


def test_combat_guard_allows_next_turn(fresh_db):
    """Same character, next turn — guard must NOT block."""
    char_id = _make_character(fresh_db, hp=100)

    # Turn 12
    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        char.hp_current -= 20
        char.last_combat_applied_turn = 12

    # Turn 13 — different turn number, guard should allow
    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        if char.last_combat_applied_turn != 13:
            char.hp_current -= 15
            char.last_combat_applied_turn = 13

    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        assert char.hp_current == 65   # 100 - 20 - 15
        assert char.last_combat_applied_turn == 13


def test_progression_guard_prevents_double_xp(fresh_db):
    """XP/level-up gains are guarded by last_progression_applied_turn."""
    char_id = _make_character(fresh_db, xp=0)
    turn = 7

    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        if char.last_progression_applied_turn != turn:
            char.xp_current += 50
            char.last_progression_applied_turn = turn

    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        if char.last_progression_applied_turn != turn:
            char.xp_current += 50  # Guard prevents
            char.last_progression_applied_turn = turn

    with get_session() as db:
        char = db.query(Character).filter(Character.id == char_id).first()
        assert char.xp_current == 50
        assert char.last_progression_applied_turn == 7
