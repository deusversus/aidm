"""Tests for the canonicality context block utility."""

import pytest

from src.core.canonicality import format_canonicality_block


class TestFormatCanonicalityBlock:
    """Test the format_canonicality_block utility."""

    def test_all_none_returns_empty(self):
        """When all fields are None, returns empty string (custom/original worlds)."""
        result = format_canonicality_block(None, None, None)
        assert result == ""

    def test_full_combo(self):
        """Full combo produces all three sections."""
        result = format_canonicality_block(
            "canon_adjacent", "full_cast", "observable"
        )
        assert "## 📜 Canonicality Constraints" in result
        assert "Timeline Mode" in result
        assert "Canon Cast" in result
        assert "Event Fidelity" in result
        assert "canon_adjacent" in result
        assert "full_cast" in result
        assert "observable" in result

    def test_partial_timeline_only(self):
        """Only timeline_mode set."""
        result = format_canonicality_block("alternate", None, None)
        assert "Timeline Mode" in result
        assert "ALTERNATE" in result
        assert "Canon Cast" not in result
        assert "Event Fidelity" not in result

    def test_partial_cast_only(self):
        """Only canon_cast_mode set."""
        result = format_canonicality_block(None, "npcs_only", None)
        assert "Canon Cast" in result
        assert "BACKGROUND NPCs" in result.upper() or "npcs_only" in result

    def test_partial_fidelity_only(self):
        """Only event_fidelity set."""
        result = format_canonicality_block(None, None, "influenceable")
        assert "Event Fidelity" in result
        assert "influenceable" in result
        assert "alter" in result.lower()

    def test_directive_content_canon_adjacent(self):
        """canon_adjacent produces directive about same timeline."""
        result = format_canonicality_block("canon_adjacent", None, None)
        assert "SAME timeline" in result

    def test_directive_content_inspired(self):
        """inspired produces directive about original story."""
        result = format_canonicality_block("inspired", None, None)
        assert "ORIGINAL" in result

    def test_directive_content_replaced_protagonist(self):
        """replaced_protagonist says original protagonist is absent."""
        result = format_canonicality_block(None, "replaced_protagonist", None)
        assert "EXCEPT" in result or "protagonist" in result.lower()

    def test_directive_content_background_fidelity(self):
        """background events are distant noise."""
        result = format_canonicality_block(None, None, "background")
        assert "background" in result.lower() or "distant" in result.lower()

    def test_unknown_value_falls_back(self):
        """Unknown enum values produce a fallback instead of crashing."""
        result = format_canonicality_block("custom_mode", None, None)
        assert "custom_mode" in result
        assert "## 📜 Canonicality Constraints" in result

    def test_respect_instruction_present(self):
        """The block includes an instruction to respect these constraints."""
        result = format_canonicality_block("canon_adjacent", "full_cast", "observable")
        assert "Respect" in result
