"""
Shared test fixtures for AIDM v3 test suite.

Provides:
- MockLLMProvider: deterministic LLM stub (no API keys needed)
- Database fixtures: in-memory SQLite
- Mock domain objects: profiles, intents, outcomes, memory stores
- Markers: live (needs API keys), slow (>5s)
"""

import os
from collections import deque
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Set test environment BEFORE any src imports
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from pydantic import BaseModel

from src.agents.intent_classifier import IntentOutput
from src.agents.outcome_judge import OutcomeOutput
from src.db.models import Base
from src.db.session import get_engine, init_db
from src.db.state_manager import StateManager
from src.llm.provider import LLMProvider, LLMResponse

# ---------------------------------------------------------------------------
# MockLLMProvider — deterministic stub
# ---------------------------------------------------------------------------

class MockLLMProvider(LLMProvider):
    """LLM provider that returns canned responses from a queue.

    Usage:
        provider = MockLLMProvider()
        provider.queue_response("Hello world")
        resp = await provider.complete(messages=[...])
        assert resp.content == "Hello world"
    """

    def __init__(self):
        super().__init__(api_key="mock-key", default_model="mock-model")
        self._response_queue: deque[LLMResponse] = deque()
        self._schema_queue: deque[BaseModel] = deque()
        self._call_history: list[dict[str, Any]] = []

    # --- Queue helpers ---

    def queue_response(self, content: str = "", **kwargs):
        """Queue a text response."""
        self._response_queue.append(
            LLMResponse(content=content, model="mock-model", **kwargs)
        )

    def queue_schema_response(self, instance: BaseModel):
        """Queue a structured (Pydantic) response."""
        self._schema_queue.append(instance)

    @property
    def call_history(self) -> list[dict[str, Any]]:
        return self._call_history

    # --- LLMProvider interface ---

    @property
    def name(self) -> str:
        return "mock"

    def get_default_model(self) -> str:
        return "mock-model"

    def get_fast_model(self) -> str:
        return "mock-fast"

    def get_creative_model(self) -> str:
        return "mock-creative"

    async def complete(
        self,
        messages,
        system=None,
        model=None,
        max_tokens=1024,
        temperature=0.7,
        extended_thinking=False,
    ) -> LLMResponse:
        self._call_history.append({
            "method": "complete",
            "messages": messages,
            "system": system,
            "model": model,
        })
        if self._response_queue:
            return self._response_queue.popleft()
        return LLMResponse(content="mock response", model="mock-model")

    async def complete_with_schema(
        self,
        messages,
        schema,
        system=None,
        model=None,
        max_tokens=1024,
        extended_thinking=False,
    ) -> BaseModel:
        self._call_history.append({
            "method": "complete_with_schema",
            "messages": messages,
            "schema": schema,
            "system": system,
            "model": model,
        })
        if self._schema_queue:
            return self._schema_queue.popleft()
        # Build a minimal instance from schema defaults
        return schema.model_construct()

    async def complete_with_tools(
        self,
        messages,
        tools,
        system=None,
        model=None,
        max_tokens=4096,
        max_tool_rounds=5,
    ) -> LLMResponse:
        self._call_history.append({
            "method": "complete_with_tools",
            "messages": messages,
            "system": system,
            "model": model,
        })
        if self._response_queue:
            return self._response_queue.popleft()
        return LLMResponse(content="mock tool response", model="mock-model")

    def _init_client(self):
        pass  # No real client needed


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_provider():
    """Fresh MockLLMProvider instance."""
    return MockLLMProvider()


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
    """Create an in-memory SQLite database with all tables."""
    init_db()
    yield get_engine()
    # Teardown: drop all tables
    Base.metadata.drop_all(bind=get_engine())


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


@pytest.fixture
def mock_profile():
    """Minimal mock NarrativeProfile for testing."""
    profile = MagicMock()
    profile.id = "cowboy_bebop"
    profile.name = "Cowboy Bebop"
    profile.dna = {
        "realism_fantasy": 0.4,
        "comedy_drama": 0.5,
        "action_intrigue": 0.7,
        "episodic_serial": 0.6,
        "light_dark": 0.5,
    }
    profile.tropes = {
        "active_tropes": ["cowboy_brotherhood"],
        "available_tropes": ["hot_spring_episode"],
    }
    profile.combat_system = "gun_kata"
    profile.power_system = "none"
    profile.tone_keywords = ["jazzy", "melancholic", "cool"]
    profile.composition = {"dialogue_weight": 0.4, "action_weight": 0.3}
    profile.genre = "sci-fi noir"
    profile.voice_guidance = "Speak in a laid-back, jazzy noir tone."
    profile.authors_voice = "Shinichiro Watanabe's contemplative jazz-infused style."
    profile.season_count = 1
    profile.filler_episode_numbers = []
    return profile
