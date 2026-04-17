"""Tests for Session Zero agent model settings and fallback chain.

Verifies:
1. SZ pipeline agents are placed in the correct tier. Per the trimmed-scope
   decision (review.txt, 2026-03-12), extraction/resolution/gap run at the
   fast tier (they are structured-output analysis, not prose synthesis);
   only sz_handoff and the conversational session_zero conductor need the
   thinking tier. The merged sz_resolver_and_gap agent (commit 4b306bb)
   inherits the fast-tier placement of the agents it replaced.
2. Explicit per-agent config overrides the tier fallback.
3. If base_thinking is also absent, falls back to hardcoded last resort.
4. Tier-driven extended thinking eligibility: THINKING_TIER agents get
   extended thinking when settings.extended_thinking is True.
"""

import os
import pytest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")


# Agents expected in the fast tier (analysis, structured output, cost-sensitive).
SZ_FAST_AGENTS = ["sz_extractor", "sz_resolver_and_gap"]
# Legacy single-responsibility agent names still registered for backwards
# compatibility tests; they must stay fast-tier if referenced.
SZ_LEGACY_FAST_AGENTS = ["sz_gap_analyzer", "sz_entity_resolver"]
# Agents expected in the thinking tier (synthesis / player-facing reasoning).
SZ_THINKING_AGENTS = ["sz_handoff", "session_zero"]


class TestAgentTierMembership:
    """SZ pipeline agents must land in the tier their role demands."""

    def test_sz_thinking_agents_in_thinking_tier(self):
        from src.settings.models import AgentSettings
        for agent in SZ_THINKING_AGENTS:
            assert agent in AgentSettings.THINKING_TIER, (
                f"{agent} not in THINKING_TIER — it will not get extended "
                "thinking or base_thinking fallback"
            )

    def test_session_zero_in_thinking_tier(self):
        from src.settings.models import AgentSettings
        assert "session_zero" in AgentSettings.THINKING_TIER

    def test_sz_fast_agents_in_fast_tier(self):
        from src.settings.models import AgentSettings
        for agent in SZ_FAST_AGENTS + SZ_LEGACY_FAST_AGENTS:
            assert agent in AgentSettings.FAST_TIER, (
                f"{agent} expected in FAST_TIER (analysis/structured output)"
            )
            assert agent not in AgentSettings.THINKING_TIER
            assert agent not in AgentSettings.CREATIVE_TIER


class TestAgentModelFallback:
    """get_agent_model() must follow: explicit → base_thinking → hardcoded last resort."""

    def _make_store_with(self, base_thinking=None, explicit_agents=None):
        """Build a minimal SettingsStore with controlled model config."""
        from src.settings.store import SettingsStore
        from src.settings.models import AgentSettings, ModelConfig

        store = SettingsStore.__new__(SettingsStore)
        agent_models = AgentSettings()
        if base_thinking:
            agent_models.base_thinking = ModelConfig(
                provider=base_thinking[0], model=base_thinking[1]
            )
        if explicit_agents:
            for agent_name, (prov, model) in explicit_agents.items():
                setattr(agent_models, agent_name, ModelConfig(provider=prov, model=model))

        store._settings_cache = MagicMock()
        store._settings_cache.agent_models = agent_models
        store.load = MagicMock(return_value=MagicMock(agent_models=agent_models))
        return store

    def test_sz_agent_falls_back_to_base_thinking(self):
        # sz_handoff is the thinking-tier SZ agent; sz_extractor et al. are
        # fast-tier now and would route through base_fast instead.
        store = self._make_store_with(base_thinking=("anthropic", "claude-sonnet-4-6"))
        provider_name, model = store.get_agent_model("sz_handoff")
        assert provider_name == "anthropic"
        assert "claude" in model

    def test_explicit_config_overrides_base_thinking(self):
        store = self._make_store_with(
            base_thinking=("anthropic", "claude-sonnet-4-6"),
            explicit_agents={"sz_handoff": ("openai", "gpt-4o")},
        )
        provider_name, model = store.get_agent_model("sz_handoff")
        assert provider_name == "openai"
        assert model == "gpt-4o"

    def test_thinking_sz_agents_resolve_via_base_thinking(self):
        """Thinking-tier SZ agents must fall back to base_thinking."""
        store = self._make_store_with(base_thinking=("openai", "gpt-4.1"))
        for agent in SZ_THINKING_AGENTS:
            provider_name, model = store.get_agent_model(agent)
            assert provider_name == "openai", f"{agent}: expected openai, got {provider_name}"
            assert model == "gpt-4.1", f"{agent}: expected gpt-4.1, got {model}"

    def test_fallback_to_last_resort_when_no_base(self):
        """When base_thinking is None, get_agent_model must still return something."""
        store = self._make_store_with(base_thinking=None)
        provider_name, model = store.get_agent_model("sz_handoff")
        # Just verify it returns a non-empty tuple — last resort varies by env
        assert isinstance(provider_name, str) and len(provider_name) > 0
        assert isinstance(model, str) and len(model) > 0


class TestExtendedThinkingEligibility:
    """THINKING_TIER agents must be eligible for extended thinking when enabled."""

    def test_thinking_sz_agents_eligible_for_extended_thinking(self):
        from src.settings.models import AgentSettings
        for agent in SZ_THINKING_AGENTS:
            assert agent in AgentSettings.THINKING_TIER, (
                f"{agent} must be in THINKING_TIER to receive extended thinking"
            )

    def test_fast_tier_agents_not_eligible(self):
        from src.settings.models import AgentSettings
        for agent in AgentSettings.FAST_TIER:
            assert agent not in AgentSettings.THINKING_TIER


class TestAgentSettingsModelConfig:
    """AgentSettings model fields for SZ compiler agents must exist."""

    def test_sz_agent_fields_exist_in_agent_settings(self):
        from src.settings.models import AgentSettings
        settings = AgentSettings()
        for agent in SZ_FAST_AGENTS + SZ_THINKING_AGENTS:
            assert hasattr(settings, agent), f"AgentSettings missing field: {agent}"
            assert getattr(settings, agent) is None  # None means "use tier fallback"

    def test_base_thinking_field_exists(self):
        from src.settings.models import AgentSettings
        settings = AgentSettings()
        assert hasattr(settings, "base_thinking")
