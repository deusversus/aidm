"""Tests for the OverrideHandler.

Covers pattern detection, target extraction, DB operations,
and context formatting — all with mocked DB and MemoryStore.
"""

from unittest.mock import MagicMock

import pytest

# We test the pure-logic methods without needing a real DB session
from src.agents.override_handler import OverrideHandler

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db():
    """Mock SQLAlchemy session."""
    db = MagicMock()
    db.add = MagicMock()
    db.commit = MagicMock()
    db.refresh = MagicMock(side_effect=lambda obj: setattr(obj, 'id', 1))
    return db


@pytest.fixture
def handler(mock_db, mock_memory_store):
    return OverrideHandler(db=mock_db, memory_store=mock_memory_store)


# ---------------------------------------------------------------------------
# Tests: Category Detection
# ---------------------------------------------------------------------------

class TestDetectCategory:
    """_detect_category should match patterns to categories."""

    def test_npc_protection(self, handler):
        assert handler._detect_category("Kai cannot die") == "NPC_PROTECTION"
        assert handler._detect_category("She must survive") == "NPC_PROTECTION"

    def test_content_constraint(self, handler):
        assert handler._detect_category("no torture scenes") == "CONTENT_CONSTRAINT"
        assert handler._detect_category("avoid romance") == "CONTENT_CONSTRAINT"

    def test_narrative_demand(self, handler):
        assert handler._detect_category("I want a boss fight here") == "NARRATIVE_DEMAND"
        assert handler._detect_category("this must happen next") == "NARRATIVE_DEMAND"

    def test_tone_requirement(self, handler):
        assert handler._detect_category("more comedy please") == "TONE_REQUIREMENT"
        assert handler._detect_category("make it darker") == "TONE_REQUIREMENT"

    def test_default_category(self, handler):
        """Unmatched content should default to NARRATIVE_DEMAND."""
        assert handler._detect_category("xyzzy foo bar") == "NARRATIVE_DEMAND"


# ---------------------------------------------------------------------------
# Tests: Target Extraction
# ---------------------------------------------------------------------------

class TestExtractTarget:
    def test_extracts_capitalized_name(self, handler):
        target = handler._extract_target("Kai cannot die", "NPC_PROTECTION")
        assert target == "Kai"

    def test_skips_common_words(self, handler):
        """Should skip 'I', 'The', 'My', 'No'."""
        target = handler._extract_target("I want The quest to end", "NARRATIVE_DEMAND")
        # Should skip "I" and "The", return None or another word
        assert target is None or target not in ("I", "The", "My", "No")

    def test_returns_none_for_no_names(self, handler):
        target = handler._extract_target("no more gore", "CONTENT_CONSTRAINT")
        assert target is None


# ---------------------------------------------------------------------------
# Tests: Process Meta
# ---------------------------------------------------------------------------

class TestProcessMeta:
    def test_returns_accepted(self, handler, mock_memory_store):
        result = handler.process_meta("more comedy please", campaign_id=1)
        assert result["status"] == "accepted"
        assert result["type"] == "meta"
        assert result["memory_created"] is True

    def test_calls_add_memory(self, handler, mock_memory_store):
        handler.process_meta("darker tone", campaign_id=1, session_number=3)
        mock_memory_store.add_memory.assert_called_once()
        call_kwargs = mock_memory_store.add_memory.call_args
        assert "darker tone" in call_kwargs.kwargs.get("content", call_kwargs[1].get("content", ""))


# ---------------------------------------------------------------------------
# Tests: Process Override
# ---------------------------------------------------------------------------

class TestProcessOverride:
    def test_creates_override(self, handler, mock_db):
        result = handler.process_override("Kai cannot die", campaign_id=1)
        assert result["status"] == "created"
        assert result["category"] == "NPC_PROTECTION"
        mock_db.add.assert_called_once()
        mock_db.commit.assert_called_once()

    def test_warning_for_npc_protection(self, handler):
        result = handler.process_override("Kai must survive", campaign_id=1)
        assert "cannot be meaningfully threatened" in result["warning"]


# ---------------------------------------------------------------------------
# Tests: Format Overrides
# ---------------------------------------------------------------------------

class TestFormatOverrides:
    def test_empty_when_no_overrides(self, handler, mock_db):
        mock_db.query.return_value.filter.return_value.all.return_value = []
        result = handler.format_overrides_for_context(campaign_id=1)
        assert result == ""

    def test_formats_active_overrides(self, handler, mock_db):
        override = MagicMock()
        override.category = "NPC_PROTECTION"
        override.description = "Kai cannot die"
        override.target = "Kai"
        mock_db.query.return_value.filter.return_value.all.return_value = [override]

        result = handler.format_overrides_for_context(campaign_id=1)
        assert "PLAYER OVERRIDES" in result
        assert "Kai cannot die" in result


# ---------------------------------------------------------------------------
# Tests: get_warning_for_category
# ---------------------------------------------------------------------------

class TestWarningForCategory:
    def test_known_categories(self, handler):
        assert "threatened" in handler._get_warning_for_category("NPC_PROTECTION", "")
        assert "constraint" in handler._get_warning_for_category("CONTENT_CONSTRAINT", "").lower()
        assert "coherence" in handler._get_warning_for_category("NARRATIVE_DEMAND", "").lower()
        assert "tone" in handler._get_warning_for_category("TONE_REQUIREMENT", "").lower()

    def test_unknown_category(self, handler):
        warning = handler._get_warning_for_category("UNKNOWN", "")
        assert warning == "Override active."
