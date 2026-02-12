"""
Test foreshadowing persistence (#10).

Verifies:
1. Seeds persist to DB via write-through
2. Seeds survive ledger restart (simulating server restart)
3. _next_id survives restart (no ID collision)
4. Mention/resolve/abandon mutations persist
5. In-memory-only mode still works (state_manager=None)
"""

import sys
import os

# Add the parent directory so we can import src
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.db.models import Base, ForeshadowingSeedDB
from src.db.state_manager import StateManager
from src.core.foreshadowing import (
    ForeshadowingLedger, SeedType, SeedStatus, ForeshadowingSeed
)

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def make_test_db():
    """Create an in-memory SQLite DB with all tables."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    return engine, Session


def make_state_manager(db_session, campaign_id=1):
    """Create a StateManager wired to a test DB session."""
    sm = StateManager(campaign_id=campaign_id)
    sm._db = db_session
    # Ensure campaign exists
    from src.db.models import Campaign
    campaign = Campaign(id=campaign_id, name="Test", profile_id="test")
    db_session.add(campaign)
    db_session.commit()
    return sm


def test_plant_persists_to_db():
    """Plant a seed → verify row appears in DB."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    ledger = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    seed_id = ledger.plant_seed(
        seed_type=SeedType.MYSTERY,
        description="The hooded figure's identity",
        planted_narrative="A cloaked figure watched from the rooftop.",
        expected_payoff="Reveal the figure is the protagonist's mentor.",
        turn_number=3,
        session_number=1,
        tags=["mysterious_figure", "rooftop"],
        related_npcs=["Mentor"]
    )
    
    # Verify in DB
    row = db.query(ForeshadowingSeedDB).filter(
        ForeshadowingSeedDB.seed_id == seed_id
    ).first()
    
    assert row is not None, "Seed should be in DB"
    assert row.seed_type == "mystery"
    assert row.status == "planted"
    assert row.description == "The hooded figure's identity"
    assert row.planted_turn == 3
    assert "Mentor" in row.related_npcs
    print("✓ test_plant_persists_to_db")
    db.close()


def test_restart_loads_from_db():
    """Plant seeds, create new ledger instance → seeds should load from DB."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    # Plant seeds in first ledger
    ledger1 = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    id1 = ledger1.plant_seed(
        seed_type=SeedType.PLOT, description="Seed A",
        planted_narrative="A happened.", expected_payoff="A resolves.",
        turn_number=1, session_number=1
    )
    id2 = ledger1.plant_seed(
        seed_type=SeedType.THREAT, description="Seed B",
        planted_narrative="B happened.", expected_payoff="B resolves.",
        turn_number=2, session_number=1
    )
    
    # "Restart" — create new instance with same state_manager
    ledger2 = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    
    assert len(ledger2._seeds) == 2, f"Expected 2 seeds, got {len(ledger2._seeds)}"
    assert id1 in ledger2._seeds
    assert id2 in ledger2._seeds
    assert ledger2._seeds[id1].description == "Seed A"
    assert ledger2._seeds[id2].seed_type == SeedType.THREAT
    print("✓ test_restart_loads_from_db")
    db.close()


def test_next_id_survives_restart():
    """_next_id from DB should prevent ID collision after restart."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    ledger1 = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    ledger1.plant_seed(
        seed_type=SeedType.PLOT, description="First",
        planted_narrative="x", expected_payoff="y",
        turn_number=1, session_number=1
    )
    ledger1.plant_seed(
        seed_type=SeedType.PLOT, description="Second",
        planted_narrative="x", expected_payoff="y",
        turn_number=2, session_number=1
    )
    # _next_id should be 3
    
    # "Restart"
    ledger2 = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    assert ledger2._next_id == 3, f"Expected _next_id=3, got {ledger2._next_id}"
    
    # Plant a new seed — should be seed_1_3, not seed_1_1
    new_id = ledger2.plant_seed(
        seed_type=SeedType.CHARACTER, description="Third",
        planted_narrative="z", expected_payoff="w",
        turn_number=3, session_number=1
    )
    assert new_id == "seed_1_3", f"Expected seed_1_3, got {new_id}"
    print("✓ test_next_id_survives_restart")
    db.close()


def test_mention_persists():
    """mention_seed should update DB."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    ledger = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    sid = ledger.plant_seed(
        seed_type=SeedType.MYSTERY, description="Who?",
        planted_narrative="x", expected_payoff="y",
        turn_number=1, session_number=1
    )
    
    # Mention 3 times to trigger GROWING status
    ledger.mention_seed(sid, turn_number=5)
    ledger.mention_seed(sid, turn_number=6)
    ledger.mention_seed(sid, turn_number=7)
    
    # Verify in DB
    row = db.query(ForeshadowingSeedDB).filter(
        ForeshadowingSeedDB.seed_id == sid
    ).first()
    
    assert row.mentions == 4, f"Expected 4 mentions, got {row.mentions}"
    assert row.last_mentioned_turn == 7
    assert row.status == "growing"
    print("✓ test_mention_persists")
    db.close()


def test_resolve_persists():
    """resolve_seed should update DB."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    ledger = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    sid = ledger.plant_seed(
        seed_type=SeedType.CHEKHOV, description="The sword",
        planted_narrative="A sword on the wall.", expected_payoff="Used in battle.",
        turn_number=1, session_number=1
    )
    
    ledger.resolve_seed(sid, turn_number=20, resolution_narrative="The sword was drawn in the final battle.")
    
    row = db.query(ForeshadowingSeedDB).filter(
        ForeshadowingSeedDB.seed_id == sid
    ).first()
    
    assert row.status == "resolved"
    assert row.resolved_turn == 20
    assert "final battle" in row.resolution_narrative
    print("✓ test_resolve_persists")
    db.close()


def test_abandon_persists():
    """abandon_seed should update DB."""
    engine, Session = make_test_db()
    db = Session()
    sm = make_state_manager(db)
    
    ledger = ForeshadowingLedger(campaign_id=1, state_manager=sm)
    sid = ledger.plant_seed(
        seed_type=SeedType.PROMISE, description="The treasure",
        planted_narrative="A map was found.", expected_payoff="Finding the treasure.",
        turn_number=1, session_number=1
    )
    
    ledger.abandon_seed(sid, reason="Player chose a different path")
    
    row = db.query(ForeshadowingSeedDB).filter(
        ForeshadowingSeedDB.seed_id == sid
    ).first()
    
    assert row.status == "abandoned"
    assert "different path" in row.resolution_narrative
    print("✓ test_abandon_persists")
    db.close()


def test_pure_in_memory_mode():
    """state_manager=None should work as pure in-memory (backwards compat)."""
    ledger = ForeshadowingLedger(campaign_id=99)
    sid = ledger.plant_seed(
        seed_type=SeedType.PLOT, description="In-memory only",
        planted_narrative="x", expected_payoff="y",
        turn_number=1, session_number=1
    )
    
    assert sid in ledger._seeds
    ledger.mention_seed(sid, 5)
    assert ledger._seeds[sid].mentions == 2
    
    ledger.resolve_seed(sid, 10, "done")
    assert ledger._seeds[sid].status == SeedStatus.RESOLVED
    print("✓ test_pure_in_memory_mode")


if __name__ == "__main__":
    test_plant_persists_to_db()
    test_restart_loads_from_db()
    test_next_id_survives_restart()
    test_mention_persists()
    test_resolve_persists()
    test_abandon_persists()
    test_pure_in_memory_mode()
    print("\n✅ All 7 foreshadowing persistence tests passed!")
