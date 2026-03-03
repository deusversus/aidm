"""Tests for StateManager deferred_commit() and StateTransaction integration.

Validates:
1. Deferred commit batches mutations atomically
2. Deferred commit rolls back all changes on exception
3. Standalone mutations still commit immediately
4. StateTransaction composes with deferred commit
5. Reentrant deferred_commit is safe
"""

import os

import pytest

# Set test environment before imports
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ANTHROPIC_API_KEY"] = "test-key"

from src.db.models import WorldState
from src.db.session import init_db
from src.db.state_manager import StateManager


@pytest.fixture(autouse=True)
def fresh_db():
    """Reset the in-memory database before each test."""
    import src.db.session as session_module
    # Reset the singleton engine and session factory so each test
    # gets a completely fresh in-memory SQLite database
    if session_module._engine is not None:
        session_module._engine.dispose()
    session_module._engine = None
    session_module._SessionLocal = None

    init_db()
    yield


@pytest.fixture
def state(fresh_db):
    """Create a fresh StateManager with an in-memory DB."""
    sm = StateManager(campaign_id=1)
    sm.ensure_campaign_exists(name="Test Campaign", profile_id="test_profile")

    # Update the default character created by ensure_campaign_exists
    db = sm._get_db()
    char = sm.get_character()
    char.name = "Test Hero"
    char.hp_current = 100
    char.hp_max = 100
    char.level = 1
    char.mp_current = 50
    char.mp_max = 100
    char.sp_current = 30
    char.sp_max = 50

    # Update the default world state created by ensure_campaign_exists
    from src.db.models import WorldState
    world = db.query(WorldState).filter(
        WorldState.campaign_id == 1
    ).first()
    world.location = "Test Town"
    world.time_of_day = "noon"
    world.situation = "All is calm."
    world.arc_phase = "rising"
    world.tension_level = 0.3
    db.commit()

    yield sm
    sm.close()


class TestDeferredCommitAtomicity:
    """Test that deferred_commit batches all mutations."""

    def test_deferred_commit_applies_all(self, state):
        """All mutations inside block should persist after clean exit."""
        with state.deferred_commit():
            state.apply_consequence("A dark storm gathers.")
            state.update_world_state(tension_level=0.8)

        # Verify both mutations persisted
        world = state.get_world_state()
        assert "dark storm" in world.situation
        assert world.tension_level == 0.8

    def test_deferred_commit_single_commit(self, state):
        """Should only call db.commit() once at block exit, not per method."""
        db = state._get_db()
        original_commit = db.commit
        commit_count = 0

        def counting_commit():
            nonlocal commit_count
            commit_count += 1
            original_commit()

        db.commit = counting_commit

        with state.deferred_commit():
            state.apply_consequence("Event 1")
            state.apply_consequence("Event 2")
            state.update_world_state(tension_level=0.9)

        # Only 1 commit at block exit
        assert commit_count == 1
        db.commit = original_commit


class TestDeferredCommitRollback:
    """Test that deferred_commit rolls back on exception."""

    def test_rollback_on_exception(self, state):
        """All mutations should be rolled back if an exception occurs."""
        original_situation = state.get_world_state().situation
        original_tension = state.get_world_state().tension_level

        with pytest.raises(ValueError):
            with state.deferred_commit():
                state.apply_consequence("This should be rolled back!")
                state.update_world_state(tension_level=9.9)
                raise ValueError("Simulated mid-transaction failure")

        # After rollback, need to re-query since session was rolled back
        # The objects may be expired after rollback, so force a fresh query
        db = state._get_db()
        world = db.query(WorldState).filter(
            WorldState.campaign_id == state.campaign_id
        ).first()
        assert "rolled back" not in world.situation
        assert world.tension_level != 9.9

    def test_flag_reset_after_rollback(self, state):
        """_commit_deferred should be False after rollback."""
        with pytest.raises(RuntimeError):
            with state.deferred_commit():
                raise RuntimeError("boom")

        assert state._commit_deferred is False

    def test_flag_reset_after_success(self, state):
        """_commit_deferred should be False after successful commit."""
        with state.deferred_commit():
            state.apply_consequence("test")

        assert state._commit_deferred is False


class TestStandaloneCommit:
    """Test that mutations outside deferred block still work normally."""

    def test_immediate_commit(self, state):
        """Without deferred_commit, mutations commit immediately."""
        state.apply_consequence("Immediate event")

        world = state.get_world_state()
        assert "Immediate event" in world.situation

    def test_maybe_commit_behavior(self, state):
        """_maybe_commit should actually commit when not deferred."""
        assert state._commit_deferred is False

        db = state._get_db()
        original_commit = db.commit
        committed = False

        def track_commit():
            nonlocal committed
            committed = True
            original_commit()

        db.commit = track_commit
        state._maybe_commit()
        assert committed is True
        db.commit = original_commit

    def test_maybe_commit_suppressed_when_deferred(self, state):
        """_maybe_commit should NOT commit when deferred."""
        db = state._get_db()
        original_commit = db.commit
        committed = False

        def track_commit():
            nonlocal committed
            committed = True
            original_commit()

        db.commit = track_commit
        state._commit_deferred = True
        state._maybe_commit()
        assert committed is False
        state._commit_deferred = False
        db.commit = original_commit


class TestReentrantDeferred:
    """Test that nested deferred_commit blocks work correctly."""

    def test_reentrant_is_safe(self, state):
        """Nested deferred_commit should be a no-op (reentrant)."""
        with state.deferred_commit():
            state.apply_consequence("Outer block")
            with state.deferred_commit():
                state.update_world_state(tension_level=0.7)
            # Inner block should NOT commit early
            state.apply_consequence("After inner block")

        world = state.get_world_state()
        assert "Outer block" in world.situation
        assert "After inner block" in world.situation
        assert world.tension_level == 0.7


class TestStateTransactionWithDeferredCommit:
    """Test StateTransaction composing with deferred_commit."""

    def test_transaction_within_deferred_commit(self, state):
        """StateTransaction should compose correctly with deferred mode."""
        with state.deferred_commit():
            with state.begin_transaction("Resource cost") as txn:
                txn.subtract("resources.mp.current", 20, reason="Spell cost")
                # Auto-commit at exit goes through _maybe_commit -> deferred

            state.apply_consequence("Cast a powerful spell!")

        # Both transaction and consequence should persist
        char = state.get_character()
        assert char.mp_current == 30  # 50 - 20

        world = state.get_world_state()
        assert "powerful spell" in world.situation

    def test_transaction_validation_failure_rollback(self, state):
        """StateTransaction rollback should not affect other mutations."""
        with state.deferred_commit():
            with state.begin_transaction("Overspend") as txn:
                txn.subtract("resources.mp.current", 999, reason="Massive spell")
                validation = txn.validate()
                if not validation.is_valid:
                    txn.rollback()

            # Other mutations should still proceed
            state.apply_consequence("Failed to cast spell")

        # MP unchanged, consequence applied
        char = state.get_character()
        assert char.mp_current == 50  # Unchanged

        world = state.get_world_state()
        assert "Failed to cast" in world.situation


class TestRecordTurnDeferred:
    """Test that record_turn works correctly within deferred block."""

    def test_record_turn_deferred(self, state):
        """record_turn should work within deferred_commit."""
        state.start_session()

        with state.deferred_commit():
            turn = state.record_turn(
                player_input="I attack the goblin",
                intent={"intent": "COMBAT", "action": "attack"},
                outcome={"consequence": "Hit!"},
                narrative="You strike the goblin with your sword.",
                latency_ms=150
            )
            state.update_world_state(situation="Combat in progress")

        assert turn is not None
        assert turn.player_input == "I attack the goblin"

        world = state.get_world_state()
        assert "Combat in progress" in world.situation
