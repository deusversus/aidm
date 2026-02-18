"""Tests for AIDM v3 canonical StrEnum types.

Validates that all enums serialize as plain strings,
have the expected members, and are JSON-serializable.
"""

import json

import pytest

from src.enums import (
    ArcPhase,
    ConsequenceCategory,
    IntentType,
    MemoryCategory,
    NarrativeWeight,
    NPCIntelligenceStage,
    OPArchetype,
    OPNarrativeFocus,
    OPPowerExpression,
    OPTensionSource,
    PacingBeat,
    PacingStrength,
    StoryScale,
    SuccessLevel,
)


class TestIntentType:
    """IntentType enum must match LLM output schema (UPPERCASE)."""

    EXPECTED = {
        "COMBAT", "SOCIAL", "EXPLORATION", "ABILITY", "INVENTORY",
        "WORLD_BUILDING", "META_FEEDBACK", "OVERRIDE_COMMAND", "OP_COMMAND", "OTHER",
    }

    def test_has_all_members(self):
        assert {e.value for e in IntentType} == self.EXPECTED

    def test_str_serialization(self):
        assert str(IntentType.COMBAT) == "COMBAT"
        assert f"{IntentType.SOCIAL}" == "SOCIAL"

    def test_equality_with_raw_string(self):
        """StrEnum values must compare equal to their string counterparts."""
        assert IntentType.COMBAT == "COMBAT"
        assert "EXPLORATION" == IntentType.EXPLORATION


class TestSuccessLevel:
    def test_members(self):
        assert {e.value for e in SuccessLevel} == {"failure", "partial", "success", "critical"}

    def test_str_round_trip(self):
        assert SuccessLevel("success") is SuccessLevel.SUCCESS


class TestNarrativeWeight:
    def test_members(self):
        assert {e.value for e in NarrativeWeight} == {"minor", "standard", "significant", "climactic"}


class TestConsequenceCategory:
    def test_members(self):
        assert {e.value for e in ConsequenceCategory} == {
            "political", "environmental", "relational", "economic", "magical"
        }


class TestArcPhase:
    def test_members(self):
        assert {e.value for e in ArcPhase} == {
            "exposition", "rising_action", "climax", "falling_action", "resolution"
        }


class TestPacingBeat:
    def test_members(self):
        expected = {"setup", "rising", "escalation", "climax", "falling", "resolution", "transition"}
        assert {e.value for e in PacingBeat} == expected


class TestPacingStrength:
    def test_members(self):
        assert {e.value for e in PacingStrength} == {"suggestion", "strong", "override"}


class TestOPArchetype:
    def test_members(self):
        assert {e.value for e in OPArchetype} == {"saitama", "mob", "overlord", "rimuru", "mashle"}


class TestStoryScale:
    def test_members(self):
        assert {e.value for e in StoryScale} == {
            "personal", "local", "continental", "planetary", "cosmic", "mythic"
        }


class TestNPCIntelligenceStage:
    def test_members(self):
        assert {e.value for e in NPCIntelligenceStage} == {
            "reactive", "contextual", "anticipatory", "autonomous"
        }


class TestMemoryCategory:
    def test_members(self):
        assert {e.value for e in MemoryCategory} == {
            "dialogue", "action", "plot_critical", "relationship", "combat", "lore", "episodic"
        }


class TestJSONSerialization:
    """All enums must survive JSON round-trip."""

    @pytest.mark.parametrize("enum_cls", [
        IntentType, SuccessLevel, NarrativeWeight, ConsequenceCategory,
        ArcPhase, PacingBeat, PacingStrength, OPArchetype,
        OPTensionSource, OPPowerExpression, OPNarrativeFocus,
        StoryScale, NPCIntelligenceStage, MemoryCategory,
    ])
    def test_json_round_trip(self, enum_cls):
        for member in enum_cls:
            dumped = json.dumps(member.value)
            loaded = json.loads(dumped)
            assert loaded == member.value
            assert enum_cls(loaded) is member
