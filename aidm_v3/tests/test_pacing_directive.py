"""Tests for the PacingAgent and PacingDirective model.

Covers Pydantic validation, system prompt content,
and PacingAgent.check() behavior with mocked LLM.
"""


import pytest

from src.agents.pacing_agent import PacingAgent, PacingDirective

# ---------------------------------------------------------------------------
# Tests: PacingDirective model validation
# ---------------------------------------------------------------------------

class TestPacingDirectiveModel:
    def test_valid_directive(self):
        d = PacingDirective(
            arc_beat="rising",
            escalation_target=0.5,
            tone="dramatic",
        )
        assert d.arc_beat == "rising"
        assert d.escalation_target == 0.5
        assert d.strength == "suggestion"  # default

    def test_escalation_bounds(self):
        """escalation_target must be in [0, 1]."""
        with pytest.raises(Exception):
            PacingDirective(
                arc_beat="rising",
                escalation_target=1.5,  # invalid
                tone="dramatic",
            )

    def test_defaults(self):
        d = PacingDirective(
            arc_beat="setup",
            escalation_target=0.1,
            tone="quiet",
        )
        assert d.must_reference == []
        assert d.avoid == []
        assert d.foreshadowing_hint == ""
        assert d.pacing_note == ""
        assert d.strength == "suggestion"
        assert d.phase_transition == ""

    def test_strength_values(self):
        """All valid strength values should be accepted."""
        for s in ("suggestion", "strong", "override"):
            d = PacingDirective(
                arc_beat="climax",
                escalation_target=0.9,
                tone="action",
                strength=s,
            )
            assert d.strength == s

    def test_with_optional_fields(self):
        d = PacingDirective(
            arc_beat="escalation",
            escalation_target=0.7,
            tone="tense",
            must_reference=["villain reveal"],
            avoid=["comic relief"],
            foreshadowing_hint="sword_prophecy",
            pacing_note="Build toward the confrontation",
            strength="strong",
            phase_transition="rising → climax",
        )
        assert d.must_reference == ["villain reveal"]
        assert d.phase_transition == "rising → climax"


# ---------------------------------------------------------------------------
# Tests: PacingAgent properties
# ---------------------------------------------------------------------------

class TestPacingAgentProperties:
    def test_output_schema(self):
        agent = PacingAgent()
        assert agent.output_schema is PacingDirective

    def test_agent_name(self):
        agent = PacingAgent()
        assert agent.agent_name == "pacing"

    def test_system_prompt_contains_phase_gate_table(self):
        agent = PacingAgent()
        prompt = agent.system_prompt
        assert "Phase Gate" in prompt or "phase gate" in prompt.lower()
        assert "setup" in prompt
        assert "override" in prompt

    def test_system_prompt_contains_key_rules(self):
        agent = PacingAgent()
        prompt = agent.system_prompt
        assert "player drives the story" in prompt.lower()


# ---------------------------------------------------------------------------
# Tests: PacingAgent.check()
# ---------------------------------------------------------------------------

class TestPacingAgentCheck:
    @pytest.fixture
    def pacing_agent(self, mock_llm_manager):
        return PacingAgent()

    async def test_check_returns_directive(self, pacing_agent, mock_llm_manager):
        """check() should return a PacingDirective when LLM succeeds."""
        expected = PacingDirective(
            arc_beat="rising",
            escalation_target=0.4,
            tone="tense",
        )
        # Get the mock provider and queue the response
        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        provider.queue_schema_response(expected)

        result = await pacing_agent.check(
            player_input="I draw my sword",
            intent_summary="COMBAT: Draw weapon",
            bible_notes="Villain encounter planned",
            arc_phase="rising_action",
            tension_level=0.5,
            situation="Forest clearing, night",
            recent_summary="Player entered the dark forest",
            turns_in_phase=3,
        )
        assert result is not None

    async def test_check_returns_none_on_failure(self, pacing_agent, mock_llm_manager):
        """check() should return None on LLM failure (non-fatal)."""
        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        # Make complete_with_schema raise
        original_complete = provider.complete_with_schema
        async def failing_complete(*args, **kwargs):
            raise Exception("LLM unavailable")
        provider.complete_with_schema = failing_complete

        result = await pacing_agent.check(
            player_input="test",
            intent_summary="OTHER: test",
            bible_notes="",
            arc_phase="exposition",
            tension_level=0.1,
            situation="tavern",
            recent_summary="",
        )
        assert result is None
        # Restore
        provider.complete_with_schema = original_complete
