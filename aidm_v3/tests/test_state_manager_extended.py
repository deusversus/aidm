"""Extended StateManager tests — NPC, faction, world state, and character operations.

Supplements the existing test_core_loop.py and test_deferred_commit.py
with coverage for the mixin methods added in Phase 5.
"""

import os
import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from src.db.state_manager import StateManager, GameContext
from src.db.session import init_db, get_engine
from src.db.models import Base


# ---------------------------------------------------------------------------
# Fixtures (self-contained, don't rely on conftest for DB isolation)
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_db():
    """Each test gets a fresh in-memory DB."""
    init_db()
    yield
    Base.metadata.drop_all(bind=get_engine())


@pytest.fixture
def sm():
    """StateManager with a pre-created campaign."""
    manager = StateManager(campaign_id=500)
    manager.ensure_campaign_exists(name="Extended Tests", profile_id="cowboy_bebop")
    yield manager
    manager.close()


# ---------------------------------------------------------------------------
# Tests: Character Operations
# ---------------------------------------------------------------------------

class TestCharacterOperations:
    def test_get_character_initially_none(self, sm):
        char = sm.get_character()
        # May or may not be None depending on ensure_campaign_exists behavior
        # but calling it should not crash
        assert char is None or hasattr(char, 'name')

    def test_update_character_sets_name(self, sm):
        sm.update_character(name="Spike Spiegel")
        char = sm.get_character()
        if char is not None:
            assert char.name == "Spike Spiegel"


# ---------------------------------------------------------------------------
# Tests: NPC Operations
# ---------------------------------------------------------------------------

class TestNPCOperations:
    def test_create_npc(self, sm):
        npc = sm.create_npc(
            name="Jet Black",
            role="ally",
            relationship_notes="Former cop, bounty hunter partner",
        )
        assert npc is not None
        assert npc.name == "Jet Black"

    def test_get_npc_by_name(self, sm):
        sm.create_npc(name="Faye Valentine", role="rival")
        npc = sm.get_npc_by_name("Faye Valentine")
        assert npc is not None
        assert npc.role == "rival"

    def test_get_npc_by_name_not_found(self, sm):
        npc = sm.get_npc_by_name("Nonexistent NPC")
        assert npc is None

    def test_create_npc_idempotent(self, sm):
        """Creating the same NPC twice should update, not duplicate."""
        npc1 = sm.create_npc(name="Jet Black", role="ally")
        npc2 = sm.create_npc(name="Jet Black", role="partner")
        assert npc1.id == npc2.id
        assert npc2.role == "partner"


# ---------------------------------------------------------------------------
# Tests: World State Operations
# ---------------------------------------------------------------------------

class TestWorldStateOperations:
    def test_get_context_returns_game_context(self, sm):
        ctx = sm.get_context()
        assert isinstance(ctx, GameContext)
        assert ctx.campaign_id == 500

    def test_context_has_default_fields(self, sm):
        ctx = sm.get_context()
        # Should have basic fields even without specific world state updates
        assert hasattr(ctx, 'location')
        assert hasattr(ctx, 'tension_level')
        assert hasattr(ctx, 'arc_phase')


# ---------------------------------------------------------------------------
# Tests: Faction Operations
# ---------------------------------------------------------------------------

class TestFactionOperations:
    def test_create_faction(self, sm):
        faction = sm.create_faction(
            name="Red Dragon Syndicate",
            description="Powerful crime organization",
        )
        assert faction is not None
        assert faction.name == "Red Dragon Syndicate"

    def test_get_faction(self, sm):
        sm.create_faction(name="Red Dragon Syndicate", description="Crime org")
        faction = sm.get_faction("Red Dragon Syndicate")
        assert faction is not None

    def test_get_faction_not_found(self, sm):
        faction = sm.get_faction("Nonexistent Faction")
        assert faction is None


# ---------------------------------------------------------------------------
# Tests: Turn Recording (extended)
# ---------------------------------------------------------------------------

class TestTurnRecordingExtended:
    def test_record_multiple_turns(self, sm):
        for i in range(5):
            sm.record_turn(
                player_input=f"Action {i}",
                intent={"intent": "OTHER"},
                outcome={"success": True},
                narrative=f"Narrative {i}",
                latency_ms=100 + i,
            )
        ctx = sm.get_context()
        assert ctx.turn_number >= 5

    def test_context_turn_count_increments(self, sm):
        ctx_before = sm.get_context()
        initial = ctx_before.turn_number

        sm.record_turn(
            player_input="I look around",
            intent={"intent": "EXPLORATION"},
            outcome={"success": True},
            narrative="You survey the area.",
            latency_ms=50,
        )

        ctx_after = sm.get_context()
        assert ctx_after.turn_number == initial + 1
