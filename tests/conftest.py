"""
Shared test fixtures for AIDM v3 test suite.

Provides:
- MockLLMProvider: deterministic LLM stub (no API keys needed)
- Database fixtures: in-memory SQLite
- Mock domain objects: profiles, intents, outcomes, memory stores
- Markers: live (needs API keys), slow (>5s)
"""

import os
from unittest.mock import MagicMock, patch

import pytest

# Set test environment BEFORE any src imports
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from src.agents.intent_classifier import IntentOutput
from src.agents.outcome_judge import OutcomeOutput
from src.db.models import Base
from src.db.session import get_engine, init_db
from src.db.state_manager import StateManager

# MockLLMProvider lives in its own module so it can be imported directly
# without going through conftest fixture machinery.
from tests.mock_llm import MockLLMProvider

__all__ = ["MockLLMProvider"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_provider():
    """Fresh MockLLMProvider instance.

    Auto-asserts that all queued responses were consumed at test teardown.
    If a test queues responses that never get called, the test will fail with
    a clear message listing the unconsumed items.
    """
    provider = MockLLMProvider()
    yield provider
    provider.assert_queue_empty()


@pytest.fixture
def mock_llm_manager(mock_provider):
    """Patch get_llm_manager to return a manager using MockLLMProvider."""
    manager = MagicMock()
    manager.get_provider.return_value = mock_provider
    manager.get_provider_for_agent.return_value = (mock_provider, "mock-model")
    manager.primary_provider = "mock"
    manager.get_fast_model.return_value = "mock-fast"
    manager.get_creative_model.return_value = "mock-creative"

    with patch("src.llm.manager.get_llm_manager", return_value=manager) as p:
        # Also patch from agents.base where it's imported directly
        with patch("src.agents.base.get_llm_manager", return_value=manager):
            yield manager


@pytest.fixture
def fresh_db():
    """Provide a clean-data DB, preserving schema across tests.

    On SQLite (the default in-memory test URL), we drop + recreate — cheap.
    On Postgres (shared dev DB), we TRUNCATE all ORM-known tables with
    CASCADE so data resets without nuking the schema that alembic owns.
    All tables with FKs to ``campaigns`` (including previously ORM-less
    ``campaign_memories``, ``context_blocks``, etc.) have ORM classes now,
    so the sorted_tables list is complete.
    """
    init_db()
    engine = get_engine()
    yield engine
    try:
        if engine.dialect.name == "postgresql":
            import sqlalchemy as sa
            names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
            if names:
                with engine.begin() as conn:
                    conn.execute(sa.text(
                        f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE"
                    ))
        else:
            Base.metadata.drop_all(bind=engine)
    except Exception:
        # Teardown is best-effort; leaking data between tests is better
        # than blocking the suite on a teardown failure.
        pass


@pytest.fixture
def state_manager(fresh_db):
    """StateManager with a pre-created campaign on an in-memory DB."""
    sm = StateManager(campaign_id=1)
    sm.ensure_campaign_exists(name="Test Campaign", profile_id="cowboy_bebop")
    yield sm
    sm.close()


@pytest.fixture
def mock_memory_store():
    """MagicMock MemoryStore with sensible search defaults."""
    store = MagicMock()
    store.search.return_value = []
    store.search_hybrid.return_value = []
    store.add_memory.return_value = None
    return store


@pytest.fixture
def sample_intent():
    """Ready-made IntentOutput for COMBAT."""
    return IntentOutput(
        intent="COMBAT",
        action="Attack the guard",
        target="guard",
        declared_epicness=0.6,
        special_conditions=["named_attack"],
    )


@pytest.fixture
def sample_outcome():
    """Ready-made OutcomeOutput."""
    return OutcomeOutput(
        should_succeed=True,
        difficulty_class=12,
        modifiers={"high_ground": 2},
        calculated_roll=14,
        success_level="success",
        narrative_weight="significant",
        reasoning="14 vs DC 12 = success",
    )


