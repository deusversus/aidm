"""Tests for the AIDM v3 core loop."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import os

# Set test environment before imports
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["ANTHROPIC_API_KEY"] = "test-key"

from src.db.models import Base, Campaign, Session, Turn, Character, WorldState
from src.db.session import get_engine, init_db, get_session
from src.db.state_manager import StateManager, GameContext
from src.profiles.loader import load_profile, NarrativeProfile
from src.agents.intent_classifier import IntentClassifier, IntentOutput
from src.agents.outcome_judge import OutcomeJudge, OutcomeOutput


class TestDatabaseSetup:
    """Tests for database initialization and models."""
    
    def test_init_db_creates_tables(self):
        """Test that init_db creates all tables."""
        init_db()
        engine = get_engine()
        
        # Check tables exist
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        
        assert "campaigns" in tables
        assert "sessions" in tables
        assert "turns" in tables
        assert "characters" in tables
        assert "npcs" in tables
        assert "world_state" in tables
    
    def test_create_campaign(self):
        """Test creating a campaign."""
        init_db()
        
        with get_session() as session:
            campaign = Campaign(name="Test Campaign", profile_id="hunterxhunter")
            session.add(campaign)
            session.flush()
            
            assert campaign.id is not None
            assert campaign.name == "Test Campaign"


class TestStateManager:
    """Tests for the state manager."""
    
    def test_ensure_campaign_exists_creates(self):
        """Test that ensure_campaign_exists creates a new campaign."""
        init_db()
        
        manager = StateManager(campaign_id=999)
        campaign = manager.ensure_campaign_exists(
            name="New Campaign",
            profile_id="hunterxhunter"
        )
        
        assert campaign is not None
        assert campaign.name == "New Campaign"
        manager.close()
    
    def test_get_context_returns_valid_context(self):
        """Test that get_context returns a GameContext."""
        init_db()
        
        manager = StateManager(campaign_id=998)
        manager.ensure_campaign_exists()
        
        context = manager.get_context()
        
        assert isinstance(context, GameContext)
        assert context.campaign_id == 998
        manager.close()
    
    def test_record_turn_increments_count(self):
        """Test that recording turns increments the turn number."""
        init_db()
        
        manager = StateManager(campaign_id=997)
        manager.ensure_campaign_exists()
        
        turn1 = manager.record_turn(
            player_input="Test action 1",
            intent={"intent": "OTHER"},
            outcome={"success": True},
            narrative="Test narrative 1",
            latency_ms=100
        )
        
        turn2 = manager.record_turn(
            player_input="Test action 2",
            intent={"intent": "COMBAT"},
            outcome={"success": False},
            narrative="Test narrative 2",
            latency_ms=200
        )
        
        assert turn1.turn_number == 1
        assert turn2.turn_number == 2
        manager.close()


class TestProfileLoader:
    """Tests for the profile loader."""
    
    def test_load_hunterxhunter_profile(self):
        """Test loading the Hunter x Hunter profile."""
        profile = load_profile("hunterxhunter")
        
        assert isinstance(profile, NarrativeProfile)
        assert profile.id == "hunterxhunter"
        assert profile.name == "Hunter x Hunter"
        assert profile.dna.get("tactical") == 9
        assert profile.tropes.get("named_attacks") is True
        assert profile.tropes.get("power_of_friendship") is False
    
    def test_load_nonexistent_profile_raises(self):
        """Test that loading a nonexistent profile raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            load_profile("nonexistent_profile")


class TestIntentClassifier:
    """Tests for the intent classifier agent."""
    
    def test_output_schema(self):
        """Test that the output schema is correct."""
        classifier = IntentClassifier()
        assert classifier.output_schema == IntentOutput
    
    def test_system_prompt_exists(self):
        """Test that the system prompt is defined."""
        classifier = IntentClassifier()
        assert len(classifier.system_prompt) > 100
        assert "intent classifier" in classifier.system_prompt.lower()


class TestOutcomeJudge:
    """Tests for the outcome judge agent."""
    
    def test_output_schema(self):
        """Test that the output schema is correct."""
        judge = OutcomeJudge()
        assert judge.output_schema == OutcomeOutput
    
    def test_system_prompt_exists(self):
        """Test that the system prompt is defined."""
        judge = OutcomeJudge()
        assert len(judge.system_prompt) > 100
        assert "outcome" in judge.system_prompt.lower()


class TestIntentOutput:
    """Tests for the IntentOutput model."""
    
    def test_valid_intent_output(self):
        """Test creating a valid IntentOutput."""
        output = IntentOutput(
            intent="COMBAT",
            action="Attack the enemy",
            target="enemy",
            declared_epicness=0.7,
            special_conditions=["named_attack"]
        )
        
        assert output.intent == "COMBAT"
        assert output.declared_epicness == 0.7
    
    def test_epicness_bounds(self):
        """Test that epicness is bounded 0-1."""
        with pytest.raises(Exception):  # Pydantic validation error
            IntentOutput(
                intent="COMBAT",
                action="Test",
                declared_epicness=1.5  # Invalid
            )


class TestOutcomeOutput:
    """Tests for the OutcomeOutput model."""
    
    def test_valid_outcome_output(self):
        """Test creating a valid OutcomeOutput."""
        output = OutcomeOutput(
            should_succeed=True,
            success_level="success",
            narrative_weight="significant",
            reasoning="Test reasoning"
        )
        
        assert output.should_succeed is True
        assert output.success_level == "success"
    
    def test_optional_fields(self):
        """Test that cost and consequence are optional."""
        output = OutcomeOutput(
            should_succeed=True,
            success_level="success",
            narrative_weight="minor",
            reasoning="No cost or consequence"
        )
        
        assert output.cost is None
        assert output.consequence is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
